// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/scheduling/db-helpers`
 * Purpose: Database helpers for scheduling stack tests.
 * Scope: Query and poll graph_runs and execution_requests tables. Does not modify data.
 * Invariants:
 *   - Polling respects timeout to avoid infinite waits
 *   - Uses getSeedDb() (BYPASSRLS) for queries on RLS-protected tables
 *   - Per SINGLE_RUN_LEDGER: queries graph_runs (promoted from schedule_runs)
 * Side-effects: IO (database reads)
 * Links: tests/stack/scheduling/*.stack.test.ts, db/schema.scheduling.ts
 * @public
 */

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, like } from "drizzle-orm";
import { executionRequests, graphRuns } from "@/shared/db/schema";

/** Default poll interval for waiting */
const POLL_INTERVAL_MS = 100;

/** Default timeout for waiting operations */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Polls for a graph_runs row to appear for the given scheduleId.
 * Returns the first row found, or throws if timeout exceeded.
 *
 * @param scheduleId - The schedule UUID
 * @param timeoutMs - Max time to wait (default 10s)
 * @returns The graph_runs row
 */
export async function waitForScheduleRunCreated(
  scheduleId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<typeof graphRuns.$inferSelect> {
  const db = getSeedDb();
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const rows = await db
      .select()
      .from(graphRuns)
      .where(eq(graphRuns.scheduleId, scheduleId))
      .limit(1);

    if (rows.length > 0 && rows[0]) {
      return rows[0];
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timeout waiting for graph_runs row for scheduleId=${scheduleId}`
  );
}

/**
 * Gets all graph_runs rows for a given scheduleId.
 *
 * @param scheduleId - The schedule UUID
 * @returns Array of graph_runs rows
 */
export async function getScheduleRuns(
  scheduleId: string
): Promise<Array<typeof graphRuns.$inferSelect>> {
  const db = getSeedDb();
  return db
    .select()
    .from(graphRuns)
    .where(eq(graphRuns.scheduleId, scheduleId));
}

/**
 * Gets an execution_requests row by exact idempotency key.
 *
 * @param idempotencyKey - The full idempotency key (scheduleId:scheduledFor)
 * @returns The execution_requests row or null
 */
export async function getExecutionRequest(
  idempotencyKey: string
): Promise<typeof executionRequests.$inferSelect | null> {
  const db = getSeedDb();
  const rows = await db
    .select()
    .from(executionRequests)
    .where(eq(executionRequests.idempotencyKey, idempotencyKey))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Gets all execution_requests rows matching a prefix (e.g., scheduleId:).
 * Useful for finding all requests for a given schedule.
 *
 * @param prefix - The idempotency key prefix to match
 * @returns Array of execution_requests rows
 */
export async function getExecutionRequestsByPrefix(
  prefix: string
): Promise<Array<typeof executionRequests.$inferSelect>> {
  const db = getSeedDb();
  return db
    .select()
    .from(executionRequests)
    .where(like(executionRequests.idempotencyKey, `${prefix}%`));
}

/**
 * Waits for graph_runs row to reach a terminal status (success, error, skipped).
 *
 * @param scheduleId - The schedule UUID
 * @param timeoutMs - Max time to wait (default 10s)
 * @returns The graph_runs row with terminal status
 */
export async function waitForScheduleRunCompleted(
  scheduleId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<typeof graphRuns.$inferSelect> {
  const db = getSeedDb();
  const startTime = Date.now();
  const terminalStatuses = ["success", "error", "skipped"];

  while (Date.now() - startTime < timeoutMs) {
    const rows = await db
      .select()
      .from(graphRuns)
      .where(eq(graphRuns.scheduleId, scheduleId))
      .limit(1);

    const row = rows[0];
    if (row && terminalStatuses.includes(row.status)) {
      return row;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timeout waiting for graph_runs completion for scheduleId=${scheduleId}`
  );
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
