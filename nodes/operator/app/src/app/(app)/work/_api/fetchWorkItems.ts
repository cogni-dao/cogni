// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems`
 * Purpose: Client-side fetch wrapper for work items list.
 * Scope: Calls /api/v1/work/items with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed WorkItemsListOutput or throws
 * Side-effects: IO
 * Links: [work.items.list.v1.contract](../../../../contracts/work.items.list.v1.contract.ts)
 * @internal
 */

import type { WorkItemDto, WorkItemsListOutput } from "@cogni/node-contracts";

const PAGE_SIZE = 500;
// Hard cap on cursor-walk to avoid runaway loops in degenerate cases (corpus
// is ~1k today; raising the ceiling here is cheap relative to a stuck UI).
const MAX_PAGES = 20;

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
  const response = await fetch(`/api/v1/work/items/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch work item",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<WorkItemDto>;
}
