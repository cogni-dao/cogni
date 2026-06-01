// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/schedules/_api/fetchSchedules`
 * Purpose: Client-side fetch wrapper for schedules list.
 * Scope: Calls /api/v1/schedules with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed SchedulesListOutput or throws
 * Side-effects: IO
 * Links: [schedules.list.v1.contract](../../../../contracts/schedules.list.v1.contract.ts)
 * @internal
 */

import type { SchedulesListOutput } from "@cogni/node-contracts";

export async function fetchSchedules(): Promise<SchedulesListOutput> {
  const response = await fetch("/api/v1/schedules", {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch schedules",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
