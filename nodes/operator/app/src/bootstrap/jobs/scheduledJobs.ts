// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/scheduledJobs`
 * Purpose: The thin registration + lifecycle helper behind `defineScheduledJob`.
 *   Turns a registered job into a Temporal schedule via the EXISTING create path
 *   (scheduleManager.createSchedule with `route = /api/internal/jobs/<id>`), and
 *   exposes pause/resume/cancel passthroughs. A node dev never calls any of these —
 *   the app owns schedule lifecycle (CRUD_AUTHORITY).
 * Scope: Wiring only. Does NOT fork the create path, the adapter, NodeTaskWorkflow,
 *   the worker, or queues — it reuses them verbatim.
 * Invariants:
 *   - REUSE_CREATE_PATH: schedules are created through container.scheduleManager
 *     .createSchedule (same call the /api/v1/schedules route makes), with `route` set
 *     so the adapter wires workflowType=NodeTaskWorkflow + the per-node queue + the
 *     task:dispatch:<nodeId>:<route> grant. We pass NO graphId.
 *   - SYSTEM_PRINCIPAL: app-owned schedules are owned by COGNI_SYSTEM_PRINCIPAL_USER_ID
 *     / COGNI_SYSTEM_BILLING_ACCOUNT_ID (seeded), like governance schedules.
 *   - DEDUP_BY_ROUTE: a job's schedule is identified by its stored graphId tunnel
 *     `task:<route>` (the user-path createSchedule has no temporalScheduleId), so
 *     re-registration is idempotent.
 *   - PAUSE_RESUME_VIA_ENABLED: updateSchedule({enabled}) drives Temporal pause/resume;
 *     cancel = deleteSchedule (revokes grant + removes the Temporal schedule).
 * Side-effects: IO (Temporal RPC, DB, grant creation) via the scheduleManager port.
 * Links: nodes/operator/app/src/shared/node-app-scaffold/scheduled-jobs,
 *   nodes/operator/app/src/app/api/internal/jobs/[jobId]/route.ts,
 *   nodes/operator/app/src/app/api/v1/schedules/route.ts (the create path we reuse)
 * @public
 */

import { toUserId } from "@cogni/ids";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import type { ScheduleSpec } from "@cogni/scheduler-core";
import { getContainer } from "@/bootstrap/container";
// Side-effect: populate the scheduled-job registry so getScheduledJob resolves.
import "@/bootstrap/jobs/scheduled-jobs.registry";
import { getNodeId } from "@/shared/config";
import {
  getScheduledJob,
  type ScheduledJobDefinition,
} from "@/shared/node-app-scaffold/scheduled-jobs";

/** Default timezone for a job that doesn't declare one. */
const DEFAULT_TIMEZONE = "UTC";

/** The node-relative dispatcher route a job's cron fires against. */
export function jobDispatchRoute(jobId: string): string {
  return `/api/internal/jobs/${jobId}`;
}

/**
 * The stored graphId tunnel the adapter writes for a NodeTask schedule
 * (`task:<route>`). Used to find a job's existing schedule for idempotent
 * (re)registration and for lifecycle ops.
 */
function jobScheduleGraphId(jobId: string): string {
  return `task:${jobDispatchRoute(jobId)}`;
}

const systemUserId = toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID);

/** Find the system-owned schedule backing a job, if one exists. */
async function findJobSchedule(jobId: string): Promise<ScheduleSpec | null> {
  const { scheduleManager } = getContainer();
  const wanted = jobScheduleGraphId(jobId);
  const existing = await scheduleManager.listSchedules(systemUserId);
  return existing.find((s) => s.graphId === wanted) ?? null;
}

/**
 * Register (or reconcile) a declared job as a Temporal schedule. Idempotent: a
 * second call for the same job is a no-op (returns the existing schedule). Reuses
 * the EXACT create path the /api/v1/schedules route uses — `route` is set, so the
 * adapter routes to NodeTaskWorkflow against this node's queue and grants
 * `task:dispatch:<nodeId>:<route>`.
 *
 * @throws Error if no job with `jobId` is registered via defineScheduledJob.
 */
export async function registerScheduledJob(
  jobId: string
): Promise<ScheduleSpec> {
  const job: ScheduledJobDefinition<never> | undefined = getScheduledJob(jobId);
  if (!job) {
    throw new Error(
      `registerScheduledJob: no job registered for id "${jobId}"`
    );
  }

  const existing = await findJobSchedule(jobId);
  if (existing) {
    return existing;
  }

  const { scheduleManager } = getContainer();
  return scheduleManager.createSchedule(
    systemUserId,
    COGNI_SYSTEM_BILLING_ACCOUNT_ID,
    {
      nodeId: getNodeId(),
      route: jobDispatchRoute(jobId),
      input: {},
      cron: job.cron,
      timezone: job.timezone ?? DEFAULT_TIMEZONE,
    }
  );
}

/** Register every job declared via defineScheduledJob. Returns created/reconciled specs. */
export async function registerAllScheduledJobs(
  jobIds: readonly string[]
): Promise<readonly ScheduleSpec[]> {
  const specs: ScheduleSpec[] = [];
  for (const jobId of jobIds) {
    specs.push(await registerScheduledJob(jobId));
  }
  return specs;
}

/** Pause a job's schedule (Temporal pause via enabled=false). No-op if absent. */
export async function pauseScheduledJob(jobId: string): Promise<void> {
  const existing = await findJobSchedule(jobId);
  if (!existing) return;
  const { scheduleManager } = getContainer();
  await scheduleManager.updateSchedule(systemUserId, existing.id, {
    enabled: false,
  });
}

/** Resume a job's schedule (Temporal resume via enabled=true). No-op if absent. */
export async function resumeScheduledJob(jobId: string): Promise<void> {
  const existing = await findJobSchedule(jobId);
  if (!existing) return;
  const { scheduleManager } = getContainer();
  await scheduleManager.updateSchedule(systemUserId, existing.id, {
    enabled: true,
  });
}

/** Cancel a job's schedule (delete + revoke grant). No-op if absent. */
export async function cancelScheduledJob(jobId: string): Promise<void> {
  const existing = await findJobSchedule(jobId);
  if (!existing) return;
  const { scheduleManager } = getContainer();
  await scheduleManager.deleteSchedule(systemUserId, existing.id);
}
