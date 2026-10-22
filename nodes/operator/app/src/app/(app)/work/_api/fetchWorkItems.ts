// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrappers for work-item list pages and exact-item reads.
 * Scope: Calls /api/v1/work/items with type-safe contracts. Does not implement business logic.
 * Invariants: Exact-item failures stay typed so only HTTP 404 can render not-found.
 *   LEAN_LIST (bug.5509): list pages request `view=lean` (no summary/outcome);
 *   the detail pane reads those bodies via the exact-item fetch.
 *   PROGRESSIVE_LIST: callers fetch one page at a time so page 1 renders
 *   while later pages stream in; the cursor walk stops at MAX_PAGES.
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type { WorkItemDto, WorkItemsListOutput } from "@cogni/node-contracts";

export const WORK_ITEMS_PAGE_SIZE = 500;
// Hard cap on cursor-walk to avoid runaway loops in degenerate cases (corpus
// is ~1k today; raising the ceiling here is cheap relative to a stuck UI).
export const MAX_WORK_ITEM_PAGES = 20;

export type WorkItemFetchErrorKind =
  | "not_found"
  | "auth"
  | "busy"
  | "server"
  | "network"
  | "unexpected";

export class WorkItemFetchError extends Error {
  readonly kind: WorkItemFetchErrorKind;
  readonly status: number | undefined;

  constructor(kind: WorkItemFetchErrorKind, message: string, status?: number) {
    super(message);
    this.name = "WorkItemFetchError";
    this.kind = kind;
    this.status = status;
  }
}

function classifyWorkItemFetchStatus(status: number): WorkItemFetchErrorKind {
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "auth";
  if (status === 409 || status === 429 || status === 503) return "busy";
  if (status >= 500) return "server";
  return "unexpected";
}

/** Fetch one lean list page; `cursor` null means the first page. */
export async function fetchWorkItemsPage(
  cursor: string | null
): Promise<WorkItemsListOutput> {
  const params = new URLSearchParams();
  params.set("limit", String(WORK_ITEMS_PAGE_SIZE));
  params.set("view", "lean");
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/v1/work/items?${params.toString()}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch work items",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<WorkItemsListOutput>;
}

/** React Query `getNextPageParam`: next cursor, or undefined when done/capped. */
export function nextWorkItemsCursor(
  lastPage: WorkItemsListOutput,
  allPages: readonly WorkItemsListOutput[]
): string | undefined {
  if (allPages.length >= MAX_WORK_ITEM_PAGES) return undefined;
  const next = lastPage.pageInfo?.endCursor ?? null;
  return lastPage.pageInfo?.hasMore && next ? next : undefined;
}

/**
 * Flatten loaded pages into one list. Page 1 may carry markdown-only items
 * that a later Doltgres page also returns; the later (Doltgres) row wins while
 * keeping its first-seen position.
 */
export function flattenWorkItemPages(
  pages: readonly WorkItemsListOutput[]
): WorkItemDto[] {
  const byId = new Map<string, WorkItemDto>();
  for (const page of pages) {
    for (const item of page.items) byId.set(item.id, item);
  }
  return [...byId.values()];
}

export async function fetchWorkItem(id: string): Promise<WorkItemDto> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/work/items/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new WorkItemFetchError(
      "network",
      "Unable to reach the work-item service"
    );
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch work item",
    }));
    throw new WorkItemFetchError(
      classifyWorkItemFetchStatus(response.status),
      error.error || `HTTP ${response.status}`,
      response.status
    );
  }
  return response.json() as Promise<WorkItemDto>;
}
