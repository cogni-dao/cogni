// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/startup-reconcile`
 * Purpose: Self-activate the operator's declared governance schedules from its OWN
 *   repo-spec at startup — no external trigger.
 * Scope: One detached, retry-until-success kick of runGovernanceSchedulesSyncJob per
 *   process. Delegates all sync logic to the job; owns only the trigger + retry.
 * Invariants:
 *   - SELF_RECONCILE_ON_BOOT: a repo-spec change (e.g. an attribution_pipeline profile
 *     bump) activates on the next operator deploy with NO deploy-infra POST and NO
 *     INTERNAL_OPS_TOKEN. The ops route stays for manual re-sync; it is no longer the
 *     only activation path.
 *   - RETRY_UNTIL_READY: Temporal is usually not reachable yet on first init, so a
 *     single shot would leave schedules stale. Retry with backoff until the job
 *     succeeds or attempts are exhausted (next deploy retries). The job's pg advisory
 *     lock makes every attempt — and every replica — idempotent.
 *   - FIRE_ONCE_PER_PROCESS / TEST_INERT: starts once, never in test.
 * Side-effects: IO (Temporal schedule reconcile, DB advisory lock) — async, detached.
 * Links: bootstrap/container.ts (getContainer trigger),
 *   bootstrap/jobs/syncGovernanceSchedules.job.ts, docs/spec/plugin-attribution-pipeline.md
 *
 * Triggered from getContainer() (first server use, e.g. the readyz probe), not from
 * instrumentation.ts: dep-cruiser forbids instrumentation → bootstrap, and the
 * reconcile needs the bootstrap-wired Temporal/DB deps. The job is dynamic-imported
 * so container → startup-reconcile → job → container is not a static cycle (the job
 * statically imports getContainer).
 * @public
 */

let _started = false;

/** Attempts before giving up for this process (a redeploy restarts the loop). */
const MAX_ATTEMPTS = 8;
/** Backoff between attempts — covers Temporal coming up shortly after the app. */
const RETRY_DELAY_MS = 15_000;

/**
 * Kick the governance-schedules reconcile once per process, detached. No-op on
 * repeat calls and in test. Retries on failure (Temporal not yet reachable) until
 * it succeeds or MAX_ATTEMPTS is hit; never throws into the caller.
 */
export function startGovernanceSyncOnBoot(): void {
  if (_started) {
    return;
  }
  // biome-ignore lint/style/noProcessEnv: startup gate, before the config framework
  if (process.env.APP_ENV === "test" || process.env.VITEST === "true") {
    return;
  }
  _started = true;
  void attemptReconcile(1);
}

async function attemptReconcile(attempt: number): Promise<void> {
  try {
    // Dynamic import keeps the job (which statically imports getContainer) off this
    // module's static graph, so there is no container ↔ startup-reconcile cycle.
    const { runGovernanceSchedulesSyncJob } = await import(
      "@/bootstrap/jobs/syncGovernanceSchedules.job"
    );
    // The job self-logs (start / per-schedule action / failure) and is advisory-lock
    // guarded, so concurrent replicas and repeat attempts are safe no-ops.
    await runGovernanceSchedulesSyncJob();
  } catch {
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => void attemptReconcile(attempt + 1), RETRY_DELAY_MS);
    }
    // Exhausted: the job logged the failure; the next deploy starts a fresh loop.
  }
}
