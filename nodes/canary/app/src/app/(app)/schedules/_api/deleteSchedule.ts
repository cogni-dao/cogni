// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/schedules/_api/deleteSchedule`
 * Purpose: Client-side fetch wrapper for schedule deletion.
 * Scope: Calls DELETE /api/v1/schedules/[id]. Does not implement business logic.
 * Invariants: Returns void or throws on error
 * Side-effects: IO
 * Links: [schedules.delete.v1.contract](../../../../contracts/schedules.delete.v1.contract.ts)
 * @internal
 */

export async function deleteSchedule(id: string): Promise<void> {
  const response = await fetch(`/api/v1/schedules/${id}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to delete schedule",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}
