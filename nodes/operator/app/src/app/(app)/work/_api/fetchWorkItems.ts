// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrappers for bounded work summary pages, the work board, and exact-item reads.
 * Scope: Calls /api/v1/work/{summaries,board,items/{id}} with type-safe contracts. Does not implement business logic.
 * Invariants:
 *   - Exact-item failures stay typed so only HTTP 404 can render not-found.
 *   - Every failure is a `WorkItemFetchError` carrying the HTTP `status`; the package hooks retry only 5xx and network failures.
 *   - BOUNDED_BOARD_READS: the only list reads are one `/work/summaries` page and one `/work/board` request; nothing here walks cursors (task.0056).
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type {
  WorkItemDto,
  WorkItemSummariesListOutput,
} from "@cogni/node-contracts";
import type { WorkBoardColumns } from "@cogni/work-items";

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

async function fetchJson<T>(
  url: string,
  fallback: string,
  signal?: AbortSignal
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      ...(signal && { signal }),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new WorkItemFetchError(
      "network",
      "Unable to reach the work-item service"
    );
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: fallback }));
    throw new WorkItemFetchError(
      classifyWorkItemFetchStatus(response.status),
      error.error || `HTTP ${response.status}`,
      response.status
    );
  }
  return response.json() as Promise<T>;
}

/** One bounded, server-filtered summary page (table page or one board column page). */
export function fetchWorkItems(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<WorkItemSummariesListOutput> {
  return fetchJson(
    `/api/v1/work/summaries?${params.toString()}`,
    "Failed to fetch work items",
    signal
  );
}

/** The first page of every visible board column in one request. */
export function fetchWorkBoard(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<WorkBoardColumns> {
  return fetchJson(
    `/api/v1/work/board?${params.toString()}`,
    "Failed to fetch the work board",
    signal
  );
}

export function fetchWorkItem(
  id: string,
  signal?: AbortSignal
): Promise<WorkItemDto> {
  return fetchJson(
    `/api/v1/work/items/${encodeURIComponent(id)}`,
    "Failed to fetch work item",
    signal
  );
}
