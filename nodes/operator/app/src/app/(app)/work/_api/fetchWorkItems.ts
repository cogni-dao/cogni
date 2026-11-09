// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrappers for bounded work summary pages, the work board and exact-item reads.
 * Scope: Calls the summaries, board and item endpoints with type-safe contracts. Does not implement business logic.
 * Invariants:
 *   - Failures stay typed (`WorkItemFetchError` carries the HTTP status; the package hooks retry only 5xx and network failures) so only HTTP 404 can render not-found.
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

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      ...(signal && { signal }),
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
    const body = await response.json().catch(() => undefined);
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    throw new WorkItemFetchError(
      classifyWorkItemFetchStatus(response.status),
      message,
      response.status
    );
  }
  return response.json() as Promise<T>;
}

/** Fetch one bounded server-filtered summary page (params from the shared codec). */
export function fetchWorkItems(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<WorkItemSummariesListOutput> {
  return getJson(`/api/v1/work/summaries?${params}`, signal);
}

/** Fetch the first page of every visible board column in one request. */
export function fetchWorkBoard(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<WorkBoardColumns> {
  return getJson(`/api/v1/work/board?${params}`, signal);
}

export async function fetchWorkItem(
  id: string,
  signal?: AbortSignal
): Promise<WorkItemDto> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/work/items/${encodeURIComponent(id)}`, {
      method: "GET",
      ...(signal && { signal }),
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
