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
 *   BOUNDED_FETCH: every request (headers and body) aborts after
 *   WORK_ITEM_FETCH_TIMEOUT_MS and rejects with a retryable `timeout` error;
 *   a caller (React Query) cancellation rethrows the caller's abort as-is.
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type { WorkItemDto, WorkItemsListOutput } from "@cogni/node-contracts";

export const WORK_ITEMS_PAGE_SIZE = 500;
// Hard cap on cursor-walk to avoid runaway loops in degenerate cases (corpus
// is ~1k today; raising the ceiling here is cheap relative to a stuck UI).
export const MAX_WORK_ITEM_PAGES = 20;
export const WORK_ITEM_FETCH_TIMEOUT_MS = 20_000;

export interface WorkItemFetchOptions {
  /** Caller cancellation, e.g. React Query's `queryFn` signal. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type WorkItemFetchErrorKind =
  | "not_found"
  | "auth"
  | "busy"
  | "server"
  | "network"
  | "timeout"
  | "unexpected";

const RETRYABLE_KINDS: ReadonlySet<WorkItemFetchErrorKind> = new Set([
  "busy",
  "server",
  "network",
  "timeout",
]);

export class WorkItemFetchError extends Error {
  readonly kind: WorkItemFetchErrorKind;
  readonly status: number | undefined;

  constructor(kind: WorkItemFetchErrorKind, message: string, status?: number) {
    super(message);
    this.name = "WorkItemFetchError";
    this.kind = kind;
    this.status = status;
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

function classifyWorkItemFetchStatus(status: number): WorkItemFetchErrorKind {
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "auth";
  if (status === 409 || status === 429 || status === 503) return "busy";
  if (status >= 500) return "server";
  return "unexpected";
}

function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([...signals]);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

async function readWorkItemError(
  response: Response,
  fallback: string
): Promise<WorkItemFetchError> {
  const body = await response.json().catch(() => ({ error: fallback }));
  return new WorkItemFetchError(
    classifyWorkItemFetchStatus(response.status),
    body.error || `HTTP ${response.status}`,
    response.status
  );
}

/** GET JSON with a hard deadline covering both the headers and the body. */
async function getJsonBounded<T>(
  url: string,
  fallbackError: string,
  { signal, timeoutMs = WORK_ITEM_FETCH_TIMEOUT_MS }: WorkItemFetchOptions = {}
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: signal ? anySignal([signal, timeout]) : timeout,
    });
    if (!response.ok) throw await readWorkItemError(response, fallbackError);
    return (await response.json()) as T;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) {
      throw new WorkItemFetchError(
        "timeout",
        `Work-item request timed out after ${timeoutMs}ms`
      );
    }
    if (error instanceof WorkItemFetchError) throw error;
    throw new WorkItemFetchError(
      "network",
      "Unable to reach the work-item service"
    );
  }
}

/** Fetch one lean list page; `cursor` null means the first page. */
export function fetchWorkItemsPage(
  cursor: string | null,
  options?: WorkItemFetchOptions
): Promise<WorkItemsListOutput> {
  const params = new URLSearchParams();
  params.set("limit", String(WORK_ITEMS_PAGE_SIZE));
  params.set("view", "lean");
  if (cursor) params.set("cursor", cursor);
  return getJsonBounded<WorkItemsListOutput>(
    `/api/v1/work/items?${params.toString()}`,
    "Failed to fetch work items",
    options
  );
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

export function fetchWorkItem(
  id: string,
  options?: WorkItemFetchOptions
): Promise<WorkItemDto> {
  return getJsonBounded<WorkItemDto>(
    `/api/v1/work/items/${encodeURIComponent(id)}`,
    "Failed to fetch work item",
    options
  );
}
