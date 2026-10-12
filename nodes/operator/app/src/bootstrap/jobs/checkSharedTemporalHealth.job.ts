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
  governanceScheduleId,
  legacyGovernanceScheduleId,
} from "@cogni/scheduler-core";
import {
  type ExpectedTemporalSchedule,
  inspectSharedTemporalHealth,
  inspectSharedTemporalScheduleHealth,
  type SharedTemporalHealth,
  type SharedTemporalScheduleHealth,
  type SharedTemporalScheduleHealthReason,
  TEMPORAL_COLLECT_EPOCH_EXECUTION_BUDGET_MS,
  TEMPORAL_GRAPH_RUN_EXECUTION_BUDGET_MS,
  TEMPORAL_HEALTH_MAX_SCHEDULES,
  TEMPORAL_NODE_TASK_EXECUTION_BUDGET_MS,
} from "@/adapters/server";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { getGovernanceConfig, getNodeId, getNodeName } from "@/shared/config";
import { serverEnv } from "@/shared/env/server-env";
import {
  temporalScheduleDrift,
  temporalSubstrateCheckDurationMs,
  temporalSubstrateChecksTotal,
  temporalSubstrateLastSuccessTimestampSeconds,
  temporalSubstratePollerFresh,
} from "@/shared/observability/server/metrics";

const SCHEDULE_DECLARATION_READ_TIMEOUT_MS = 1_000;
const HEALTH_CACHE_TTL_MS = 5_000;
let cachedHealth:
  | { readonly expiresAtMs: number; readonly value: SharedTemporalNodeHealth }
  | undefined;
let healthInFlight: Promise<SharedTemporalNodeHealth> | undefined;

export interface SharedTemporalNodeHealth
  extends Omit<SharedTemporalHealth, "status" | "reason"> {
  readonly status: "healthy" | "unhealthy";
  readonly reason:
    | SharedTemporalHealth["reason"]
    | SharedTemporalScheduleHealthReason;
  readonly schedules: SharedTemporalScheduleHealth;
}

interface ScheduleRow {
  readonly dbScheduleId: string;
  readonly temporalScheduleId: string | null;
  readonly ownerUserId: string;
  readonly executionGrantId: string;
  readonly graphId: string;
  readonly enabled: boolean;
  readonly cron: string;
  readonly timezone: string;
  readonly input: unknown;
}

function belongsToCurrentNode(
  temporalScheduleId: string,
  nodeId: string,
  isOperator: boolean
): boolean {
  if (temporalScheduleId.startsWith("node-task:")) {
    return temporalScheduleId.startsWith(`node-task:${nodeId}:`);
  }
  if (temporalScheduleId.startsWith("governance:")) {
    const parts = temporalScheduleId.split(":");
    return (isOperator && parts.length === 2) || parts[1] === nodeId;
  }
  return true;
}

function actionInput(row: ScheduleRow, workflowType: string): unknown {
  if (workflowType !== "NodeTaskWorkflow") return row.input;
  const record =
    row.input && typeof row.input === "object"
      ? (row.input as Record<string, unknown>)
      : {};
  const route =
    typeof record.route === "string"
      ? record.route
      : row.graphId.startsWith("task:")
        ? row.graphId.slice("task:".length)
        : row.graphId;
  return {
    route,
    payload:
      record.payload && typeof record.payload === "object"
        ? record.payload
        : {},
  };
}

function rowToExpected(
  row: ScheduleRow,
  nodeId: string,
  defaultTaskQueue: string
): ExpectedTemporalSchedule {
  const temporalScheduleId = row.temporalScheduleId ?? row.dbScheduleId;
  const isGovernanceOrNodeDeclaration =
    temporalScheduleId.startsWith("governance:") ||
    temporalScheduleId.startsWith("node-task:");
  const isLedgerCollect = temporalScheduleId === "governance:ledger_ingest";
  const workflowType = isLedgerCollect
    ? "CollectEpochWorkflow"
    : row.graphId.startsWith("task:")
      ? "NodeTaskWorkflow"
      : "GraphRunWorkflow";
  const executionBudgetMs =
    workflowType === "CollectEpochWorkflow"
      ? TEMPORAL_COLLECT_EPOCH_EXECUTION_BUDGET_MS
      : workflowType === "NodeTaskWorkflow"
        ? TEMPORAL_NODE_TASK_EXECUTION_BUDGET_MS
        : TEMPORAL_GRAPH_RUN_EXECUTION_BUDGET_MS;
  return {
    dbScheduleId: row.dbScheduleId,
    temporalScheduleId,
    enabled: row.enabled,
    cron: row.cron,
    timezone: row.timezone,
    input: actionInput(row, workflowType),
    graphId: row.graphId,
    executionGrantId: row.executionGrantId,
    ownerUserId: row.ownerUserId,
    workflowType,
    taskQueue: isLedgerCollect ? `ledger-tasks-${nodeId}` : defaultTaskQueue,
    overlapPolicy: isGovernanceOrNodeDeclaration ? "skip" : "buffer_one",
    catchupWindowMs: isGovernanceOrNodeDeclaration ? 0 : 60_000,
    executionBudgetMs,
  };
}

function missingDeclaration(
  temporalScheduleId: string,
  cron: string,
  timezone: string,
  taskQueue: string
): ExpectedTemporalSchedule {
  return {
    dbScheduleId: `missing:${temporalScheduleId}`,
    temporalScheduleId,
    enabled: true,
    cron,
    timezone,
    input: null,
    graphId: "missing",
    executionGrantId: "missing",
    ownerUserId: "missing",
    workflowType: "missing",
    taskQueue,
    overlapPolicy: "skip",
    catchupWindowMs: 0,
    executionBudgetMs: TEMPORAL_GRAPH_RUN_EXECUTION_BUDGET_MS,
  };
}

async function listExpectedSchedules(
  nodeId: string,
  defaultTaskQueue: string
): Promise<ExpectedTemporalSchedule[]> {
  const rows = await resolveServiceDb()
    .select({
      dbScheduleId: schedules.id,
      temporalScheduleId: schedules.temporalScheduleId,
      ownerUserId: schedules.ownerUserId,
      executionGrantId: schedules.executionGrantId,
      graphId: schedules.graphId,
      enabled: schedules.enabled,
      cron: schedules.cron,
      timezone: schedules.timezone,
      input: schedules.input,
    })
    .from(schedules)
    .limit(TEMPORAL_HEALTH_MAX_SCHEDULES + 1);

  const isOperator = getNodeName() === "operator";
  const currentRows = rows.filter((row) =>
    belongsToCurrentNode(
      row.temporalScheduleId ?? row.dbScheduleId,
      nodeId,
      isOperator
    )
  );
  const expected = currentRows.map((row) =>
    rowToExpected(row, nodeId, defaultTaskQueue)
  );
  const byTemporalId = new Map(
    expected.map((item) => [item.temporalScheduleId, item])
  );

  const governance = getGovernanceConfig();
  for (const declaration of governance.schedules) {
    const id = isOperator
      ? legacyGovernanceScheduleId(declaration.charter)
      : governanceScheduleId(nodeId, declaration.charter);
    let target = byTemporalId.get(id);
    if (!target) {
      const missing = missingDeclaration(
        id,
        declaration.cron,
        declaration.timezone,
        defaultTaskQueue
      );
      expected.push(missing);
      byTemporalId.set(id, missing);
      target = missing;
    }
    const isLedgerIngest =
      declaration.charter.toUpperCase() === "LEDGER_INGEST";
    const operatorLedger = isLedgerIngest && isOperator && governance.ledger;
    const nodeLedger = isLedgerIngest && !isOperator;
    Object.assign(target, {
      enabled: true,
      cron: declaration.cron,
      timezone: declaration.timezone,
      graphId: operatorLedger
        ? "ledger:ingest"
        : nodeLedger
          ? "task:/api/internal/attribution/collect"
          : "sandbox:openclaw",
      workflowType: operatorLedger
        ? "CollectEpochWorkflow"
        : nodeLedger
          ? "NodeTaskWorkflow"
          : "GraphRunWorkflow",
      taskQueue: operatorLedger ? `ledger-tasks-${nodeId}` : defaultTaskQueue,
      input: operatorLedger
        ? {
            version: 1,
            scopeId: governance.ledger?.scopeId,
            scopeKey: governance.ledger?.scopeKey,
            epochLengthDays: governance.ledger?.epochLengthDays,
            activitySources: governance.ledger?.activitySources,
            ...(governance.ledger?.baseIssuanceCredits && {
              baseIssuanceCredits:
                governance.ledger.baseIssuanceCredits.toString(),
            }),
            ...(governance.ledger?.approvers &&
              governance.ledger.approvers.length > 0 && {
                approvers: governance.ledger.approvers,
              }),
          }
        : nodeLedger
          ? {
              route: "/api/internal/attribution/collect",
              payload: { nodeId },
            }
          : { message: declaration.entrypoint, model: "kimi-k2.5" },
      overlapPolicy: "skip",
      catchupWindowMs: 0,
      executionBudgetMs: operatorLedger
        ? TEMPORAL_COLLECT_EPOCH_EXECUTION_BUDGET_MS
        : nodeLedger
          ? TEMPORAL_NODE_TASK_EXECUTION_BUDGET_MS
          : TEMPORAL_GRAPH_RUN_EXECUTION_BUDGET_MS,
    });
  }

  return expected;
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
    failedCount: 0,
    staleCount: 0,
    missedCount: 0,
    latestDueExecution: null,
  };
}

async function runSharedTemporalHealthCheck(): Promise<SharedTemporalNodeHealth> {
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
        listExpectedSchedules(nodeId, taskQueue),
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

/**
 * One process-wide bounded probe at a time. A short cache absorbs duplicate CLI/route
 * reads without multiplying Temporal RPCs; unhealthy results are cached too so load
 * cannot amplify an outage.
 */
export async function checkSharedTemporalHealth(): Promise<SharedTemporalNodeHealth> {
  const nowMs = Date.now();
  if (cachedHealth && cachedHealth.expiresAtMs > nowMs) {
    return cachedHealth.value;
  }
  if (healthInFlight) return healthInFlight;
  healthInFlight = runSharedTemporalHealthCheck();
  try {
    const value = await healthInFlight;
    cachedHealth = { value, expiresAtMs: Date.now() + HEALTH_CACHE_TTL_MS };
    return value;
  } finally {
    healthInFlight = undefined;
  }
}

/** @internal Test-only reset for the module-level single-flight/cache. */
export function resetSharedTemporalHealthCacheForTest(): void {
  cachedHealth = undefined;
  healthInFlight = undefined;
}
