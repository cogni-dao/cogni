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
  _running = runTick().finally(() => {
    _running = null;
  });
}

async function runTick(): Promise<void> {
  try {
    // Dynamic import avoids a static container -> sync -> job -> container cycle.
    const { runNodeAdminSyncJob } = await import(
      "@/bootstrap/jobs/syncNodeAdmins.job"
    );
    await runNodeAdminSyncJob();
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
