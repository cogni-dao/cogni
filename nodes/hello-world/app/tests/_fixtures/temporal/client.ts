// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/temporal/client`
 * Purpose: Temporal client utilities for stack tests.
 * Scope: Provides singleton client and schedule trigger helper. Does not contain test logic.
 * Invariants:
 *   - Client reused across tests (expensive to create)
 *   - Uses test environment Temporal config
 * Side-effects: IO (Temporal RPC calls)
 * Links: tests/stack/scheduling/*.stack.test.ts
 * @public
 */

import { Client, Connection } from "@temporalio/client";
import type { TemporalScheduleControlConfig } from "@/adapters/server/temporal/schedule-control.adapter";

/** Centralized test Temporal config from env (single source of truth). */
export function getTestTemporalConfig(): TemporalScheduleControlConfig {
  return {
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    namespace: process.env.TEMPORAL_NAMESPACE ?? "cogni-test",
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "scheduler-tasks",
  };
}

let clientInstance: Client | null = null;
let connectionInstance: Connection | null = null;

/**
 * Returns singleton Temporal client for tests.
 * Uses TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE from env.
 */
export async function getTestTemporalClient(): Promise<Client> {
  if (clientInstance) {
    return clientInstance;
  }

  const { address, namespace } = getTestTemporalConfig();

  connectionInstance = await Connection.connect({ address });
  clientInstance = new Client({
    connection: connectionInstance,
    namespace,
  });

  return clientInstance;
}

/**
 * Triggers a Temporal schedule immediately.
 * This fires the schedule action, creating a new workflow run.
 *
 * @param scheduleId - The schedule ID (same as DB schedules.id)
 */
export async function triggerSchedule(scheduleId: string): Promise<void> {
  const client = await getTestTemporalClient();
  const handle = client.schedule.getHandle(scheduleId);
  await handle.trigger();
}

/**
 * Closes the Temporal connection.
 * Call in globalTeardown or afterAll if needed.
 */
export async function closeTemporalClient(): Promise<void> {
  if (connectionInstance) {
    await connectionInstance.close();
    connectionInstance = null;
    clientInstance = null;
  }
}
