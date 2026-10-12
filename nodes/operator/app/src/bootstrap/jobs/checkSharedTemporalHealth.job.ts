// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/checkSharedTemporalHealth`
 * Purpose: Compose the current node's read-only shared Temporal diagnostic.
 * Scope: Resolves node/env identity, invokes the adapter, and records low-cardinality metrics.
 * Invariants: Uses the same per-node task queue derivation as application workflow clients.
 * Side-effects: IO (Temporal, scheduler-worker HTTP, Prometheus metrics)
 * Links: task.5238, docs/spec/temporal-patterns.md
 * @public
 */

import { schedules } from "@cogni/db-schema/scheduling";
import {
  type ExpectedTemporalSchedule,
  inspectSharedTemporalHealth,
  inspectSharedTemporalScheduleHealth,
  type SharedTemporalHealth,
  type SharedTemporalScheduleHealth,
  type SharedTemporalScheduleHealthReason,
  TEMPORAL_HEALTH_MAX_SCHEDULES,
} from "@/adapters/server";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server-env";
import {
  temporalScheduleDrift,
  temporalSubstrateCheckDurationMs,
  temporalSubstrateChecksTotal,
  temporalSubstrateLastSuccessTimestampSeconds,
  temporalSubstratePollerFresh,
} from "@/shared/observability/server/metrics";

const SCHEDULE_DECLARATION_READ_TIMEOUT_MS = 1_000;

export interface SharedTemporalNodeHealth
  extends Omit<SharedTemporalHealth, "status" | "reason"> {
  readonly status: "healthy" | "unhealthy";
  readonly reason:
    | SharedTemporalHealth["reason"]
    | SharedTemporalScheduleHealthReason;
  readonly schedules: SharedTemporalScheduleHealth;
}

async function listExpectedSchedules(): Promise<ExpectedTemporalSchedule[]> {
  const rows = await resolveServiceDb()
    .select({
      dbScheduleId: schedules.id,
      temporalScheduleId: schedules.temporalScheduleId,
      enabled: schedules.enabled,
      timezone: schedules.timezone,
      input: schedules.input,
    })
    .from(schedules)
    .limit(TEMPORAL_HEALTH_MAX_SCHEDULES + 1);

  return rows.map((row) => ({
    dbScheduleId: row.dbScheduleId,
    temporalScheduleId: row.temporalScheduleId ?? row.dbScheduleId,
    enabled: row.enabled,
    timezone: row.timezone,
    input: row.input,
  }));
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("schedule declaration read deadline exceeded")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unavailableScheduleHealth(
  declaredCount = 0
): SharedTemporalScheduleHealth {
  return {
    status: "unhealthy",
    reason: "schedule_inspection_unavailable",
    declaredCount,
    observedCount: 0,
    reconciledCount: 0,
    pausedCount: 0,
    driftCount: 0,
    driftReasons: [],
    dueCount: 0,
    terminalCount: 0,
    latestDueExecution: null,
  };
}

export async function checkSharedTemporalHealth(): Promise<SharedTemporalNodeHealth> {
  const startedAt = performance.now();
  const env = serverEnv();
  const nodeId = getNodeId();
  const taskQueue = `${env.TEMPORAL_TASK_QUEUE}-${nodeId}`;
  const transportPromise = inspectSharedTemporalHealth({
    nodeId,
    temporalAddress: env.TEMPORAL_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue,
    schedulerWorkerHealthUrl: env.SCHEDULER_WORKER_HEALTH_URL,
    app: {
      // These are the exact sources returned by GET /version.
      // biome-ignore lint/style/noProcessEnv: build-time package identity
      version: process.env.npm_package_version || "unknown",
      buildSha: env.APP_BUILD_SHA || "unknown",
      // biome-ignore lint/style/noProcessEnv: build-time image identity
      buildTime: process.env.BUILD_TIME || null,
    },
  });
  const schedulePromise = (async () => {
    let expectedSchedules: ExpectedTemporalSchedule[] = [];
    try {
      expectedSchedules = await withDeadline(
        listExpectedSchedules(),
        SCHEDULE_DECLARATION_READ_TIMEOUT_MS
      );
      const scheduleControl = getContainer().scheduleControl;
      return await inspectSharedTemporalScheduleHealth(
        { nodeId, expectedSchedules, expectedTaskQueue: taskQueue },
        {
          listScheduleIds:
            scheduleControl.listScheduleIds.bind(scheduleControl),
          describeSchedule:
            scheduleControl.describeSchedule.bind(scheduleControl),
        }
      );
    } catch {
      return unavailableScheduleHealth(expectedSchedules.length);
    }
  })();

  const [transport, scheduleHealth] = await Promise.all([
    transportPromise,
    schedulePromise,
  ]);
  const reason =
    transport.status === "unhealthy" ? transport.reason : scheduleHealth.reason;
  const result: SharedTemporalNodeHealth = {
    ...transport,
    status: reason === "ok" ? "healthy" : "unhealthy",
    reason,
    schedules: scheduleHealth,
    durationMs: Math.round(performance.now() - startedAt),
  };

  const metricLabels = { result: result.status, reason: result.reason };
  temporalSubstrateChecksTotal.labels(metricLabels).inc();
  temporalSubstrateCheckDurationMs
    .labels(metricLabels)
    .observe(result.durationMs);
  temporalSubstratePollerFresh
    .labels({ task_type: "workflow" })
    .set(result.pollers.workflow.status === "fresh" ? 1 : 0);
  temporalSubstratePollerFresh
    .labels({ task_type: "activity" })
    .set(result.pollers.activity.status === "fresh" ? 1 : 0);
  temporalScheduleDrift.set(result.schedules.driftCount);
  if (result.status === "healthy") {
    temporalSubstrateLastSuccessTimestampSeconds.set(Date.now() / 1_000);
  }

  return result;
}
