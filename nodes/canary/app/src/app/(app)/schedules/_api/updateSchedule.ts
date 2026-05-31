// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/schedules/_api/updateSchedule`
 * Purpose: Client-side fetch wrapper for schedule updates.
 * Scope: Calls PATCH /api/v1/schedules/[id] with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed ScheduleResponse or throws
 * Side-effects: IO
 * Links: [schedules.update.v1.contract](../../../../contracts/schedules.update.v1.contract.ts)
 * @internal
 */

import type {
  ScheduleResponse,
  ScheduleUpdateInput,
} from "@cogni/node-contracts";

export interface UpdateScheduleParams {
  id: string;
  data: ScheduleUpdateInput;
}

export async function updateSchedule({
  id,
  data,
}: UpdateScheduleParams): Promise<ScheduleResponse> {
  const response = await fetch(`/api/v1/schedules/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to update schedule",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
