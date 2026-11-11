// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/items.server`
 * Purpose: Server-side facade for work item read/write operations across the markdown + Doltgres surfaces.
 * Scope: Maps content to DTOs; lists and bounded summary pages use configured Doltgres or unconfigured markdown alone. Does not own adapters or PostgreSQL coordination.
 * Invariants: PORT_VIA_CONTAINER (no direct adapter imports), CONTRACTS_ARE_TRUTH, ID_RANGE_RESERVED.
 *   Priority (including 0/1) carries no extra node-admin gate (task.5306); the store's own
 *   author-scoped write authority applies unchanged.
 * Moves (story.0033): create and patch accept `moves` (new ids are resolved and baselined by the store). A single-item read, a create response and a patch response add each move's baseline, current reading and verdict from the goal-metric observations (at most 3 moves); list reads return the stored moves only. An unknown or deprecated metric id is `EntryUnresolvedError` (field `moves`); a non-empty write with no metric wiring is `MovesUnsupportedError`; a bad list is `MovesInvalidError`; a failed baseline read is `MetricBaselineUnavailableError`.
 * Side-effects: IO (filesystem read via port; database read/write via Doltgres port; goal-metric reads for moves)
 * Links: contracts/work.items.{list,get,create,patch}.v1.contract, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @internal
 */

import type {
  WorkItemsCreateInput as ContractCreateInput,
  WorkItemsPatchInput as ContractPatchInput,
  WorkItemDto,
  WorkItemSummariesListInput,
  WorkItemSummariesListOutput,
  WorkItemsListInput,
  WorkItemsListOutput,
} from "@cogni/node-contracts";
import type {
  WorkBoardColumnPages,
  WorkItem,
  WorkItemId,
  WorkQuery,
  WorkSummaryReadOptions,
} from "@cogni/work-items";
import {
  judgeMoves,
  toWorkItemDto,
  toWorkItemId,
  WorkItemSummarySchema,
} from "@cogni/work-items";

import { createMoveMetricPorts } from "@/bootstrap/capabilities/work-item-moves";
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

/** Permanent retirement: cancel the durable item instead of reusing its identity. */
export class WorkItemDeletionRetiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemDeletionRetiredError";
  }
}

/** A current mutation may have committed; preserve lookup evidence and forbid automatic replay. */
export class WorkItemWriteOutcomeUnknownError extends Error {
  readonly code = "work_item_write_outcome_unknown";
  readonly retryable = false;
  constructor(
    readonly operationId: string,
    readonly branch: string,
    readonly commitHash?: string,
    readonly itemId?: string
  ) {
    super(
      "Work-item write outcome is unknown; inspect the operation branch and main before retrying."
    );
    this.name = "WorkItemWriteOutcomeUnknownError";
  }
  get receipt() {
    return {
      code: this.code,
      retryable: false as const,
      lookup: {
        operationId: this.operationId,
        branch: this.branch,
        commitHash: this.commitHash ?? null,
        itemId: this.itemId ?? null,
      },
    };
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
 * Thrown when a patch's `expectedRevision` no longer matches the row. RETRY
 * AFTER RE-READ: nothing was written; the route answers 409 `revision_conflict`
 * with the row's current revision.
 */
export class WorkItemRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(
    message: string,
    expectedRevision: number,
    currentRevision: number
  ) {
    super(message);
    this.name = "WorkItemRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

/** One `scores` bound violation, as reported by `parseWorkItemScores`. */
export type WorkItemScoresIssue = {
  readonly code: string;
  readonly path: readonly string[];
  readonly message: string;
};

/**
 * Thrown when a `scores` write broke the package bounds (story.5111).
 * PERMANENT, CALLER'S ERROR: the adapter's `parseWorkItemScores` (the ONLY
 * bounds check — SCORES_ONE_ENFORCER) rejected it before any SQL, so nothing
 * was written; the route answers 400 with the package issues, never 500.
 */
export class WorkItemScoresInvalidError extends Error {
  readonly code = "work_item_scores_invalid" as const;
  constructor(readonly issues: readonly WorkItemScoresIssue[]) {
    super("Invalid work-item scores");
    this.name = "WorkItemScoresInvalidError";
  }
}

/**
 * Thrown when a patch's `reason` is missing or breaks the shared rule (task.0086).
 * PERMANENT, CALLER'S ERROR: the adapter is the one enforcer, refused before any
 * lock, so nothing was written; the route answers 400 with an issue at `reason`.
 */
export class ChangeReasonInvalidError extends Error {
  readonly code = "reason_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChangeReasonInvalidError";
  }
}

/** A patch's `cites` broke the cite rules (the zod schema normally says so first). 400, nothing written. */
export class CitesInvalidError extends Error {
  readonly code = "cites_invalid" as const;
  constructor(readonly issues: readonly string[]) {
    super("Invalid cites");
    this.name = "CitesInvalidError";
  }
}

/** A patch carries cites but no resolver is wired on this node. 400, nothing written. */
export class CitesUnsupportedError extends Error {
  readonly code = "cites_unsupported" as const;
  constructor(message = "cites are not supported on this node") {
    super(message);
    this.name = "CitesUnsupportedError";
  }
}

/**
 * A cited id is unknown, or its inbox is closed or lacks it. 400, nothing written.
 * With `field: "moves"` the ids are metric ids that are unknown or deprecated (story.0033).
 */
export class EntryUnresolvedError extends Error {
  readonly code = "cite_unresolved" as const;
  constructor(
    readonly ids: readonly string[],
    readonly field: "cites" | "moves" = "cites"
  ) {
    super(
      field === "moves"
        ? `Metrics not found or deprecated: ${ids.join(", ")}`
        : `Cited entries not found: ${ids.join(", ")}`
    );
    this.name = "EntryUnresolvedError";
  }
}

/** A write's `moves` broke the bounds (the zod schema normally says so first). 400, nothing written. */
export class MovesInvalidError extends Error {
  readonly code = "moves_invalid" as const;
  constructor(readonly issues: readonly string[]) {
    super("Invalid moves");
    this.name = "MovesInvalidError";
  }
}

/** A write carries a non-empty `moves` but no metric wiring is present on this node. 400, nothing written. */
export class MovesUnsupportedError extends Error {
  readonly code = "moves_unsupported" as const;
  constructor(message = "moves are not supported on this node") {
    super(message);
    this.name = "MovesUnsupportedError";
  }
}

/** The metric baseline reader failed or ran past its deadline. 503, nothing written. */
export class MetricBaselineUnavailableError extends Error {
  readonly code = "metric_baseline_unavailable" as const;
  constructor(message = "Metric baseline is unavailable; retry shortly") {
    super(message);
    this.name = "MetricBaselineUnavailableError";
  }
}

/** The cite resolver failed or ran past its deadline. 503, nothing written. */
export class EntryResolverUnavailableError extends Error {
  readonly code = "cite_resolver_unavailable" as const;
  constructor(message = "cite resolver unavailable") {
    super(message);
    this.name = "EntryResolverUnavailableError";
  }
}

function isScoresIssue(value: unknown): value is WorkItemScoresIssue {
  const issue = value as Partial<WorkItemScoresIssue> | null;
  return (
    typeof issue?.code === "string" &&
    typeof issue.message === "string" &&
    Array.isArray(issue.path)
  );
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
  if (name === "WorkItemWriteOutcomeUnknownError") {
    const receipt = e as {
      operationId?: unknown;
      branch?: unknown;
      commitHash?: unknown;
      itemId?: unknown;
    };
    if (
      typeof receipt.operationId === "string" &&
      typeof receipt.branch === "string"
    )
      return new WorkItemWriteOutcomeUnknownError(
        receipt.operationId,
        receipt.branch,
        typeof receipt.commitHash === "string" ? receipt.commitHash : undefined,
        typeof receipt.itemId === "string" ? receipt.itemId : undefined
      );
    return e;
  }
  if (name === "WorkItemDeletionRetiredError") {
    return new WorkItemDeletionRetiredError(message);
  }
  if (name === "WorkItemAuthorizationError") {
    return new WorkItemAuthorizationError(message);
  }
  if (name === "WorkItemScoresInvalidError") {
    const issues = (e as { issues?: unknown }).issues;
    return new WorkItemScoresInvalidError(
      Array.isArray(issues) ? issues.filter(isScoresIssue) : []
    );
  }
  // task.0086: the adapter is the one enforcer of reason and cites. The facade returns its
  // own copy of each class so the app layer never imports the adapter subpath.
  if (name === "ChangeReasonInvalidError") {
    return new ChangeReasonInvalidError(message);
  }
  if (name === "CitesInvalidError") {
    const issues = (e as { issues?: unknown }).issues;
    return new CitesInvalidError(
      Array.isArray(issues) ? issues.map(String) : [message]
    );
  }
  if (name === "CitesUnsupportedError") {
    return new CitesUnsupportedError(message || undefined);
  }
  if (name === "EntryUnresolvedError") {
    const { ids, field } = e as { ids?: unknown; field?: unknown };
    return new EntryUnresolvedError(
      Array.isArray(ids) ? ids.map(String) : [],
      field === "moves" ? "moves" : "cites"
    );
  }
  // story.0033: the adapter validates `moves`, resolves new metric ids and pins the baseline.
  if (name === "MovesInvalidError") {
    const issues = (e as { issues?: unknown }).issues;
    return new MovesInvalidError(
      Array.isArray(issues) ? issues.map(String) : [message]
    );
  }
  if (name === "MovesUnsupportedError") {
    return new MovesUnsupportedError(message || undefined);
  }
  if (name === "MetricBaselineUnavailableError") {
    return new MetricBaselineUnavailableError(message || undefined);
  }
  if (name === "EntryResolverUnavailableError") {
    return new EntryResolverUnavailableError(message || undefined);
  }
  if (name === "WorkItemsBusyError") {
    return new WorkItemsBusyError(message);
  }
  if (name === "WorkItemRevisionConflictError") {
    const { expectedRevision, currentRevision } = e as {
      expectedRevision?: unknown;
      currentRevision?: unknown;
    };
    if (
      typeof expectedRevision === "number" &&
      typeof currentRevision === "number"
    ) {
      return new WorkItemRevisionConflictError(
        message,
        expectedRevision,
        currentRevision
      );
    }
  }
  return e;
}

const toDto = toWorkItemDto;

/**
 * MOVES_READ_AT_READ_TIME: add each move's baseline, current reading and verdict to a
 * single item. Never throws: a lookup that fails reads `unknown`. A list read does not call this.
 */
async function withMoveReadings(dto: WorkItemDto): Promise<WorkItemDto> {
  if (!dto.moves?.length) return dto;
  const container = getContainer();
  // No goal-metric service on this node: every move reads `unknown` (metrics_unavailable).
  const readings = container.goalMetrics
    ? createMoveMetricPorts(() => container.goalMetrics).readings
    : undefined;
  return { ...dto, moves: await judgeMoves(dto.moves, readings) };
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
    ...(input.labels && { labels: input.labels }),
    ...(input.labelPrefix && { labelPrefix: input.labelPrefix }),
    ...(input.scored !== undefined && { scored: input.scored }),
    limit: input.limit ?? 100,
    ...(input.cursor && { cursor: input.cursor }),
    ...(input.sortBy && { sortBy: input.sortBy }),
    ...(input.sortDirection && { sortDirection: input.sortDirection }),
  };

  // One backend owns the complete ordering and cursor. Mixing markdown rows
  // into a Dolt page drops matches and cannot preserve global rank order.
  try {
    const result = await container.doltgresWorkItems.list(queryShared);
    const { endCursor, hasMore } = result.pageInfo;
    return {
      items: result.items.map(toDto),
      pageInfo: { endCursor, hasMore },
      ...(endCursor !== null && { nextCursor: endCursor }),
    };
  } catch (e) {
    if ((e as Error)?.name === "InvalidCursorError") {
      throw new InvalidCursorError((e as Error).message);
    }
    // Configured outages must remain visible; this is not a failover path.
    if ((e as Error)?.name !== "DoltgresNotConfiguredError") throw e;
  }

  try {
    const result = await container.workItemQuery.list(queryShared);
    const endCursor = result.nextCursor ?? null;
    return {
      items: result.items.map(toDto),
      pageInfo: { endCursor, hasMore: endCursor !== null },
      ...(endCursor !== null && { nextCursor: endCursor }),
    };
  } catch (e) {
    if ((e as Error)?.name === "InvalidCursorError") {
      throw new InvalidCursorError((e as Error).message);
    }
    throw e;
  }
}

/** Map a store read failure; returns only when Doltgres is not configured. */
function rethrowReadUnlessNotConfigured(error: unknown): void {
  const name = (error as Error)?.name;
  if (name === "InvalidCursorError") {
    throw new InvalidCursorError((error as Error).message);
  }
  if (name !== "DoltgresNotConfiguredError") throw error;
}

/** The store query for one decoded summary request (the published codec already bounded it). */
function summaryQuery(input: WorkItemSummariesListInput): WorkQuery {
  return {
    ...(input.sortBy !== undefined && { sortBy: input.sortBy }),
    ...(input.sortDirection !== undefined && {
      sortDirection: input.sortDirection,
    }),
    ...(input.types && { types: input.types as WorkItem["type"][] }),
    ...(input.statuses && { statuses: input.statuses as WorkItem["status"][] }),
    ...(input.text && { text: input.text }),
    ...(input.actor && { actor: input.actor as WorkItem["actor"] }),
    ...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
    ...(input.projectIds && { projectIds: input.projectIds.map(toWorkItemId) }),
    ...(input.rankMin !== undefined && { rankMin: input.rankMin }),
    ...(input.rankMax !== undefined && { rankMax: input.rankMax }),
    ...(input.node && { node: input.node }),
    ...(input.labels && { labels: input.labels }),
    ...(input.labelPrefix !== undefined && { labelPrefix: input.labelPrefix }),
    ...(input.scored !== undefined && { scored: input.scored }),
    limit: input.limit ?? 25,
    ...(input.cursor && { cursor: input.cursor }),
  };
}

/**
 * One bounded summary page (task.0056). `options` (signal, shared deadline,
 * scan budget) only tightens the read. Doltgres owns the page; markdown serves
 * it only when Doltgres is not configured (same rule as `listWorkItems`).
 */
export async function listWorkSummaries(
  input: WorkItemSummariesListInput,
  options?: WorkSummaryReadOptions
): Promise<WorkItemSummariesListOutput> {
  const container = getContainer();
  const query = summaryQuery(input);
  try {
    return await container.doltgresWorkItems.listSummaries(query, options);
  } catch (error) {
    rethrowReadUnlessNotConfigured(error);
  }
  try {
    const result = await container.workItemQuery.list(query);
    return {
      items: result.items.map((item) =>
        WorkItemSummarySchema.parse(toDto(item))
      ),
      pageInfo: {
        endCursor: result.nextCursor ?? null,
        hasMore: result.nextCursor !== undefined,
      },
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    };
  } catch (error) {
    if ((error as Error)?.name === "InvalidCursorError")
      throw new InvalidCursorError((error as Error).message);
    throw error;
  }
}

/**
 * First page of every listed board column in ONE store read when the port
 * composes it (task.0056); otherwise one bounded summary read per column.
 * Text queries never reach here (the package keeps them per-column).
 */
export async function listWorkBoardColumns(
  input: WorkItemSummariesListInput,
  statuses: readonly string[],
  perColumn: number,
  options?: { readonly signal?: AbortSignal }
): Promise<WorkBoardColumnPages> {
  const port = getContainer().doltgresWorkItems;
  if (port.listBoardColumns) {
    try {
      return await port.listBoardColumns(
        summaryQuery(input),
        statuses,
        perColumn,
        options
      );
    } catch (error) {
      rethrowReadUnlessNotConfigured(error);
    }
  }
  const columns = [];
  for (const status of statuses) {
    const page = await listWorkSummaries(
      { ...input, statuses: [status], limit: perColumn },
      options
    );
    columns.push({ status, items: page.items, pageInfo: page.pageInfo });
  }
  return { columns, queryCount: columns.length };
}

export async function getWorkItem(id: string): Promise<WorkItemDto | null> {
  const container = getContainer();
  // Doltgres-first: legacy markdown IDs (e.g. bug.0002) can also live in Doltgres
  // after the markdown→Doltgres import (task.5002). Fall back to markdown only when
  // Doltgres returns null, so unimported legacy IDs still resolve during transition.
  try {
    const item = await container.doltgresWorkItems.get(toWorkItemId(id));
    if (item) return await withMoveReadings(toDto(item));
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
        ...(input.scores !== undefined && { scores: input.scores }),
        ...(input.moves !== undefined && { moves: input.moves }),
      },
      authorTagFromSession(sessionUser)
    );
    return await withMoveReadings(toDto(created));
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
        ...(input.expectedRevision !== undefined && {
          expectedRevision: input.expectedRevision,
        }),
        set: dropUndefined(input.set),
        reason: input.reason,
        ...(input.cites !== undefined && { cites: input.cites }),
      },
      authorTagFromSession(sessionUser)
    );
    if (!patched) throw new WorkItemNotFoundError(input.id);
    return await withMoveReadings(toDto(patched));
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
