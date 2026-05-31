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

import type { WorkItemsListOutput } from "@cogni/node-contracts";

export async function fetchWorkItems(): Promise<WorkItemsListOutput> {
  const response = await fetch("/api/v1/work/items", {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch work items",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
