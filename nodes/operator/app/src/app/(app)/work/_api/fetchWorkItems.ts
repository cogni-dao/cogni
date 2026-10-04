// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrappers for work-item list and exact-item reads.
 * Scope: Calls /api/v1/work/items with type-safe contracts. Does not implement business logic.
 * Invariants: Exact-item failures stay typed so only HTTP 404 can render not-found.
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type { WorkItemDto, WorkItemsListOutput } from "@cogni/node-contracts";

const PAGE_SIZE = 500;
// Hard cap on cursor-walk to avoid runaway loops in degenerate cases (corpus
// is ~1k today; raising the ceiling here is cheap relative to a stuck UI).
const MAX_PAGES = 20;

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

async function fetchOnePage(
  cursor: string | null
): Promise<WorkItemsListOutput> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
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

export async function fetchWorkItems(): Promise<WorkItemsListOutput> {
  const all: WorkItemDto[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchOnePage(cursor);
    all.push(...page.items);
    const next = page.pageInfo?.endCursor ?? null;
    const more = page.pageInfo?.hasMore ?? false;
    if (!more || !next) {
      return {
        items: all,
        pageInfo: { endCursor: null, hasMore: false },
      };
    }
    cursor = next;
  }
  return {
    items: all,
    pageInfo: { endCursor: cursor, hasMore: true },
  };
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
