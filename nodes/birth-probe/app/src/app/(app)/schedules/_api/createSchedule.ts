// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/schedules/_api/createSchedule`
 * Purpose: Client-side fetch wrapper for schedule creation.
 * Scope: Calls POST /api/v1/schedules with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed ScheduleResponse or throws
 * Side-effects: IO
 * Links: [schedules.create.v1.contract](../../../../contracts/schedules.create.v1.contract.ts)
 * @internal
 */

import type {
  ScheduleCreateInput,
  ScheduleResponse,
} from "@cogni/node-contracts";

export async function createSchedule(
  input: ScheduleCreateInput
): Promise<ScheduleResponse> {
  const response = await fetch("/api/v1/schedules", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to create schedule",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
