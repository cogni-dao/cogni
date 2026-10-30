// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/scheduling/history`
 * Purpose: Bind authenticated node identity to shared scheduling readback.
 * Scope: Delegates behavior to the published package; does not create database clients.
 * Invariants: Caller identity is validated; existing app-role reader is injected.
 * Side-effects: IO
 * Links: https://cognidao.org/work/items/task.5356
 * @internal
 */
import { toUserId } from "@cogni/ids";
import {
  createScheduleHistoryService,
  type ScheduleRunReader,
} from "@cogni/scheduling";
import type { ScheduleUserPort } from "@/ports/server";

export function createOwnedScheduleHistory(deps: {
  scheduleManager: Pick<ScheduleUserPort, "getSchedule">;
  scheduleRunReader: ScheduleRunReader;
}) {
  return createScheduleHistoryService({
    getSchedule: (caller, id) =>
      deps.scheduleManager.getSchedule(toUserId(caller), id),
    reader: deps.scheduleRunReader,
  });
}
