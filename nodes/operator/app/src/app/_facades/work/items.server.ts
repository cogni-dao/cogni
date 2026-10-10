// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/items.server`
 * Purpose: Server-side facade for work item read/write operations across the markdown + Doltgres surfaces.
 * Scope: Maps port results to contract DTOs. Routes Doltgres-allocated IDs (5000+) to the Doltgres port from `getContainer()`; legacy markdown IDs to the markdown port.
 * Invariants: PORT_VIA_CONTAINER (no direct adapter imports), CONTRACTS_ARE_TRUTH, ID_RANGE_RESERVED.
 * Side-effects: IO (filesystem read via port; database read/write via Doltgres port)
 * Links: contracts/work.items.{list,get,create,patch}.v1.contract, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @internal
 */

import type {
  WorkItemsCreateInput as ContractCreateInput,
  WorkItemsPatchInput as ContractPatchInput,
  WorkItemDto,
  WorkItemsListInput,
  WorkItemsListOutput,
} from "@cogni/node-contracts";
import type { WorkItem, WorkItemId } from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";

import { getContainer } from "@/bootstrap/container";

/**
 * Thrown when the opaque pagination cursor cannot be decoded — translated
 * to HTTP 400 in the route layer instead of the wrapper's generic 500.
 * The adapter's cursor codec throws a structurally identical error
 * (`name === "InvalidCursorError"`); the facade detects by name and
 * rethrows its own copy so the app layer doesn't have to import from
 * `@/adapters/**` (forbidden by `no-restricted-imports`).
 */
export class InvalidCursorError extends Error {
  constructor(message = "invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export class WorkItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Work item not found: ${id}`);
    this.name = "WorkItemNotFoundError";
  }
}

export class WorkItemsBackendNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemsBackendNotReadyError";
  }
}

/**
 * Thrown when the store refused the mutation for the calling principal.
 * PERMANENT: the adapter's write authority is author-scoped, so the identical
 * request can never succeed — the route answers 403, never a retryable 5xx.
 */
export class WorkItemAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemAuthorizationError";
  }
}

/**
 * Thrown when the store was momentarily unavailable (query timeout, destroyed
 * connection, contended Dolt operation branch). RETRYABLE: the identical
 * request typically succeeds on the next attempt — the route answers 503 with
 * a retry hint, never an opaque 500.
 */
export class WorkItemsBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemsBusyError";
  }
}

/**
 * Normalize a store-layer throw into a facade-owned error (bug.5408).
 *
 * The Doltgres adapter throws structurally identical errors whose `name` is
 * stable; the facade detects by name and returns its OWN copy so the app layer
 * never imports the adapter subpath — the same technique the
 * `InvalidCursorError` note above describes. An unrecognized error is returned
 * UNCHANGED so the route still answers 500: the catch is deliberately narrow.
 */
function mapStoreError(e: unknown): unknown {
  const name = (e as Error)?.name;
  const message = (e as Error)?.message ?? "";
  if (name === "DoltgresNotConfiguredError") {
    return new WorkItemsBackendNotReadyError(message);
  }
  if (name === "WorkItemAuthorizationError") {
    return new WorkItemAuthorizationError(message);
  }
  if (name === "WorkItemsBusyError") {
    return new WorkItemsBusyError(message);
  }
  return e;
}

function toDto(item: WorkItem): WorkItemDto {
  return {
    id: item.id as string,
    type: item.type,
    title: item.title,
    status: item.status,
    ...(item.actor !== "either" && { actor: item.actor }),
    priority: item.priority,
    rank: item.rank,
    estimate: item.estimate,
    summary: item.summary,
    outcome: item.outcome,
    projectId: item.projectId as string | undefined,
    parentId: item.parentId as string | undefined,
    node: item.node,
    assignees: item.assignees as WorkItemDto["assignees"],
    externalRefs: item.externalRefs as WorkItemDto["externalRefs"],
    labels: item.labels as string[],
    specRefs: item.specRefs as string[],
    branch: item.branch,
    pr: item.pr,
    reviewer: item.reviewer,
    revision: item.revision,
    blockedBy: item.blockedBy as string | undefined,
    deployVerified: item.deployVerified,
    claimedByRun: item.claimedByRun,
    claimedAt: item.claimedAt,
    lastCommand: item.lastCommand,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function authorTagFromSession(user: {
  id: string;
  displayName: string | null;
}): string {
  const handle = user.displayName?.trim() || user.id;
  return `actor:${handle}`;
}

type StripUndefined<T> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

function dropUndefined<T extends Record<string, unknown>>(
  obj: T
): StripUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as StripUndefined<T>;
}

export async function listWorkItems(
  input: WorkItemsListInput
): Promise<WorkItemsListOutput> {
  const container = getContainer();
  const queryShared = {
    ...(input.types && { types: input.types as WorkItem["type"][] }),
    ...(input.statuses && { statuses: input.statuses as WorkItem["status"][] }),
    ...(input.text && { text: input.text }),
    ...(input.actor && { actor: input.actor as WorkItem["actor"] }),
    ...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
    ...(input.node && { node: input.node }),
    ...(input.limit && { limit: input.limit }),
    ...(input.cursor && { cursor: input.cursor }),
  };

  // Pagination strategy:
  //   - Doltgres is the cursor-paginated source of truth (post-#1144 importer
  //     back-fills markdown items into Doltgres at their original IDs).
  //   - On the first page (no cursor) we ALSO query the markdown adapter so
  //     any items that haven't been imported yet still appear. Doltgres rows
  //     win on id conflict (single-source dedup).
  //   - Merged page is truncated to `limit` so the response never overflows.
  //   - hasMore tracks Doltgres only — markdown is finite/small and only
  //     contributes to page 1; once Doltgres exhausts pagination ends.
  //   - Markdown-only items that overflow page 1 are dropped from the response;
  //     this is acceptable because markdown is being deprecated and the
  //     importer back-fill closes the gap.
  let dgItems: WorkItem[] = [];
  let endCursor: string | null = null;
  let hasMore = false;

  try {
    const dgResult = await container.doltgresWorkItems.list(queryShared);
    dgItems = [...dgResult.items];
    endCursor = dgResult.pageInfo.endCursor;
    hasMore = dgResult.pageInfo.hasMore;
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "InvalidCursorError") {
      throw new InvalidCursorError((e as Error).message);
    }
    if (name !== "DoltgresNotConfiguredError") throw e;
  }

  let merged: WorkItem[] = dgItems;
  if (!input.cursor) {
    const mdResult = await container.workItemQuery.list(queryShared);
    const dgIds = new Set(dgItems.map((i) => i.id as string));
    const mdOnly = mdResult.items.filter((i) => !dgIds.has(i.id as string));
    merged = [...dgItems, ...mdOnly];
  }

  const requestedLimit = input.limit ?? 100;
  if (merged.length > requestedLimit) {
    merged = merged.slice(0, requestedLimit);
  }

  return {
    items: merged.map(toDto),
    pageInfo: { endCursor, hasMore },
    ...(endCursor !== null && { nextCursor: endCursor }),
  };
}

export async function getWorkItem(id: string): Promise<WorkItemDto | null> {
  const container = getContainer();
  // Doltgres-first: legacy markdown IDs (e.g. bug.0002) can also live in Doltgres
  // after the markdown→Doltgres import (task.5002). Fall back to markdown only when
  // Doltgres returns null, so unimported legacy IDs still resolve during transition.
  try {
    const item = await container.doltgresWorkItems.get(toWorkItemId(id));
    if (item) return toDto(item);
  } catch (e) {
    if ((e as Error)?.name !== "DoltgresNotConfiguredError") throw e;
  }
  const mdItem = await container.workItemQuery.get(id as WorkItemId);
  return mdItem ? toDto(mdItem) : null;
}

export async function createWorkItem(
  input: ContractCreateInput,
  sessionUser: { id: string; displayName: string | null }
): Promise<WorkItemDto> {
  const container = getContainer();
  try {
    const created = await container.doltgresWorkItems.create(
      {
        type: input.type,
        title: input.title,
        ...(input.id !== undefined && { id: toWorkItemId(input.id) }),
        ...(input.summary !== undefined && { summary: input.summary }),
        ...(input.outcome !== undefined && { outcome: input.outcome }),
        ...(input.specRefs !== undefined && { specRefs: input.specRefs }),
        ...(input.projectId !== undefined && {
          projectId: toWorkItemId(input.projectId),
        }),
        ...(input.parentId !== undefined && {
          parentId: toWorkItemId(input.parentId),
        }),
        ...(input.labels !== undefined && { labels: input.labels }),
        ...(input.assignees !== undefined && { assignees: input.assignees }),
        ...(input.node !== undefined && { node: input.node }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.rank !== undefined && { rank: input.rank }),
        ...(input.estimate !== undefined && { estimate: input.estimate }),
      },
      authorTagFromSession(sessionUser)
    );
    return toDto(created);
  } catch (e) {
    throw mapStoreError(e);
  }
}

export async function patchWorkItem(
  input: ContractPatchInput,
  sessionUser: { id: string; displayName: string | null }
): Promise<WorkItemDto> {
  const container = getContainer();
  try {
    const patched = await container.doltgresWorkItems.patch(
      {
        id: toWorkItemId(input.id),
        set: dropUndefined(input.set),
      },
      authorTagFromSession(sessionUser)
    );
    if (!patched) throw new WorkItemNotFoundError(input.id);
    return toDto(patched);
  } catch (e) {
    throw mapStoreError(e);
  }
}

export async function deleteWorkItem(
  id: string,
  sessionUser: { id: string; displayName: string | null }
): Promise<boolean> {
  const container = getContainer();
  try {
    return await container.doltgresWorkItems.delete(
      toWorkItemId(id),
      authorTagFromSession(sessionUser)
    );
  } catch (e) {
    throw mapStoreError(e);
  }
}
