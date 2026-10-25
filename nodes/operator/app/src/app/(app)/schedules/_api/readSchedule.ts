// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/schedules/api/readSchedule`
 * Purpose: Read validated schedule detail and history responses.
 * Scope: Client HTTP binding; does not cache transcripts or implement pagination SQL.
 * Invariants: Shared wire schemas validate responses; reads use no-store.
 * Side-effects: IO
 * Links: https://cognidao.org/work/items/task.5356
 * @internal
 */
import {
  schedulesGetOperation,
  schedulesHistoryOperation,
} from "@cogni/scheduling";

async function read(url: string): Promise<unknown> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
export async function readSchedule(id: string) {
  return schedulesGetOperation.output.parse(
    await read(`/api/v1/schedules/${encodeURIComponent(id)}`)
  );
}
export async function readScheduleRuns(id: string, cursor?: string) {
  const query = new URLSearchParams({
    limit: "20",
    ...(cursor ? { cursor } : {}),
  });
  return schedulesHistoryOperation.output.parse(
    await read(`/api/v1/schedules/${encodeURIComponent(id)}/runs?${query}`)
  );
}
