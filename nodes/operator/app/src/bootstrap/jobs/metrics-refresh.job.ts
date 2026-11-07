// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/metrics-refresh.job`
 * Purpose: The operator's one goal-metric refresh clock (story.0021) — a minutely
 *   NodeTaskWorkflow schedule on the existing scheduler-worker that POSTs
 *   `/api/internal/metrics/refresh`, plus the grant-checked run behind that route.
 * Scope: Schedule reconcile + run only. Due-metric selection and computation are
 *   `@cogni-dao/metrics` `refreshDue()`; no metrics workflow or worker.
 * Invariants:
 *   - ONE_CLOCK_PER_NODE: fixed schedule id `metrics:<nodeId>:refresh`, create-or-update.
 *   - GRANT_BOUND_DISPATCH: the run re-validates the `task:dispatch:<nodeId>:<route>` grant.
 *   - NODE_TASK_ENVELOPE: input tunnels `{ route, payload }` so the schedule-control
 *     adapter unwraps the payload the route receives as its body.
 * Side-effects: IO (Temporal schedule RPC, grant row, metric observations)
 * Links: bootstrap/startup-reconcile.ts, app/api/internal/metrics/refresh/route.ts
 * @internal
 */

import { toUserId } from "@cogni/ids";
import { SYSTEM_ACTOR } from "@cogni/ids/system";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { getContainer } from "@/bootstrap/container";
import { getNodeId } from "@/shared/config";

export const METRICS_REFRESH_ROUTE = "/api/internal/metrics/refresh";

export function metricsRefreshScheduleId(nodeId: string): string {
  return `metrics:${nodeId}:refresh`;
}

export async function ensureMetricsRefreshSchedule() {
  const container = getContainer();
  const nodeId = getNodeId();
  const grant = await container.executionGrantPort.ensureGrant({
    userId: toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID),
    billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
    scopes: [`task:dispatch:${nodeId}:${METRICS_REFRESH_ROUTE}`],
  });
  const scheduleId = metricsRefreshScheduleId(nodeId);
  const params = {
    scheduleId,
    nodeId,
    ownerUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
    cron: "* * * * *",
    timezone: "UTC",
    graphId: `task:${METRICS_REFRESH_ROUTE}`,
    executionGrantId: grant.id,
    input: {
      route: METRICS_REFRESH_ROUTE,
      payload: { executionGrantId: grant.id },
    },
    workflowType: "NodeTaskWorkflow",
    overlapPolicy: "skip" as const,
    catchupWindowMs: 0,
  };
  const previous = await container.scheduleControl.describeSchedule(scheduleId);
  if (previous) {
    await container.scheduleControl.updateSchedule(scheduleId, params);
  } else {
    try {
      await container.scheduleControl.createSchedule(params);
    } catch (error) {
      // Another replica, or an ambiguous create, may already own this id.
      // Reconcile the observed schedule instead of creating another clock.
      const current =
        await container.scheduleControl.describeSchedule(scheduleId);
      if (!current) throw error;
      await container.scheduleControl.updateSchedule(scheduleId, params);
    }
  }
  const current = await container.scheduleControl.describeSchedule(scheduleId);
  return {
    scheduleId,
    paused: current?.isPaused ?? false,
    nextRunAt: current?.nextRunAtIso,
  };
}

export async function runMetricsRefresh(executionGrantId: string) {
  const c = getContainer();
  const nodeId = getNodeId();
  await c.executionGrantWorkerPort.validateGrantForScope(
    SYSTEM_ACTOR,
    nodeId,
    executionGrantId,
    `task:dispatch:${nodeId}:${METRICS_REFRESH_ROUTE}`
  );
  if (!c.goalMetrics) throw new Error("metrics_unavailable");
  return c.goalMetrics.refreshDue();
}
