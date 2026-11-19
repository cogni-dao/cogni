// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/node-admin-sync`
 * Purpose: Run the node-admin sync on its own two-minute tick.
 * Scope: Process lifecycle and coalescing only; delegates all IO to `jobs/syncNodeAdmins.job.ts`.
 * Invariants:
 *   - OWN_TICK: a fixed two-minute interval, independent of the catalog reconcile's timers and of its
 *     first-success barrier. Nothing here is awaited by container init and nothing here rejects into it.
 *   - NO_OVERLAP: a tick that fires while one is running is dropped; the job also holds a cross-replica
 *     advisory lock.
 *   - ONE_TICK_EVENT: every tick that returns logs `identity.node_admin_sync.tick` with mode, nodes and a
 *     count per outcome, including a skipped tick and a tick with zero rows.
 *   - FAILURE_IS_LOGGED_NOT_THROWN: a failed tick is logged and the next tick tries again.
 *   - TEST_INERT: no timer ever starts in tests.
 * Side-effects: schedules a detached, unref'd interval outside tests.
 * Links: bootstrap/container.ts, bootstrap/jobs/syncNodeAdmins.job.ts, task.5494
 * @public
 */

export const NODE_ADMIN_SYNC_INTERVAL_MS = 2 * 60 * 1000;

let _started = false;
let _running: Promise<void> | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;

/** Start the tick once per process. The first tick fires immediately, detached. */
export function startNodeAdminSyncOnBoot(): void {
  if (isTestRuntime() || _started) return;
  _started = true;
  triggerNodeAdminSync();
  _timer = setInterval(triggerNodeAdminSync, NODE_ADMIN_SYNC_INTERVAL_MS);
  _timer.unref();
}

/** Run one tick now unless one is already running. Never rejects. */
export function triggerNodeAdminSync(): void {
  if (isTestRuntime() || _running) return;
  _running = runNodeAdminSyncTick().finally(() => {
    _running = null;
  });
}

/** One tick: run the job, log the tick event. Never rejects. Exported for tests; the timer is test-inert. */
export async function runNodeAdminSyncTick(): Promise<void> {
  const startedAt = Date.now();
  try {
    // Dynamic imports avoid a static container -> sync -> job -> container cycle.
    const { runNodeAdminSyncJob } = await import(
      "@/bootstrap/jobs/syncNodeAdmins.job"
    );
    const summary = await runNodeAdminSyncJob();
    const { getContainer } = await import("@/bootstrap/container");
    const { EVENT_NAMES } = await import("@/shared/observability");
    // ONE_TICK_EVENT: logged for every tick that returns, including a skipped tick and a tick with
    // zero rows, so "the sync is alive" is a positive signal and silence means it did not run.
    getContainer().log.info(
      {
        event: EVENT_NAMES.IDENTITY_NODE_ADMIN_SYNC_TICK,
        mode: summary.mode,
        nodes: summary.nodes,
        skipped: summary.skipped,
        ok: summary.byOutcome.ok ?? 0,
        unavailable: summary.byOutcome.unavailable ?? 0,
        empty: summary.byOutcome.empty ?? 0,
        refused: summary.byOutcome.refused ?? 0,
        durationMs: Date.now() - startedAt,
      },
      EVENT_NAMES.IDENTITY_NODE_ADMIN_SYNC_TICK
    );
  } catch (error) {
    try {
      const { getContainer } = await import("@/bootstrap/container");
      getContainer().log.error(
        { err: String(error) },
        "Node admin sync tick failed"
      );
    } catch {
      // No logger reachable: the next tick retries.
    }
  }
}

function isTestRuntime(): boolean {
  // biome-ignore lint/style/noProcessEnv: startup gate, before the config framework
  return process.env.APP_ENV === "test" || process.env.VITEST === "true";
}
