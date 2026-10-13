// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/reliability-status`
 * Purpose: Build ReliabilityStatusV1 from the closed metrics snapshot and database containment state.
 * Scope: Pure policy evaluation plus injected port orchestration; no HTTP, env, or adapter imports.
 * Invariants: ONE_HEALTH_CONTRACT, MISSING_DATA_FAILS_CLOSED, LOW_CARDINALITY.
 * Side-effects: IO only through injected ports.
 * Links: /api/v1/nodes/{id}/observability/health, task.5247
 * @public
 */

import type {
  ReliabilityEnvironment,
  ReliabilityState,
  ReliabilityStatusV1,
} from "@cogni/node-contracts";

import type {
  DatabaseContainmentPort,
  DatabaseContainmentReason,
  DatabaseContainmentStatus,
  MetricsQueryPort,
} from "@/ports";

export interface ReliabilityStatusInput {
  readonly nodeId: string;
  readonly slug: string;
  readonly environment: ReliabilityEnvironment;
  readonly buildSha: string | null;
  readonly desiredTier: "shared" | "dedicated" | null;
  readonly budgetProfile: string | null;
  readonly database: DatabaseContainmentStatus | null;
}

const UNKNOWN_REASON = "required reliability evidence is missing";

export async function readReliabilityStatus(
  input: ReliabilityStatusInput,
  metrics: MetricsQueryPort
): Promise<ReliabilityStatusV1> {
  const snapshot = await metrics.queryReliabilitySnapshot({
    nodeSlug: input.slug,
    environment: input.environment,
  });

  const utilization = {
    ioPressurePct: snapshot.ioPressurePct,
    connectionPct: snapshot.connectionPct,
    memoryHeadroomPct: snapshot.memoryHeadroomPct,
    diskHeadroomPct: snapshot.diskHeadroomPct,
  };
  const verdict = evaluateReliabilityPolicy({
    buildSha: input.buildSha,
    database: input.database,
    regionalReadiness: snapshot.regionalReadiness,
    utilization,
  });

  return {
    version: "reliability-status.v1",
    nodeId: input.nodeId,
    slug: input.slug,
    environment: input.environment,
    buildSha: input.buildSha,
    databaseTier: input.database?.desiredTier ?? input.desiredTier ?? "unknown",
    budgetProfile: input.database?.budgetProfile ?? input.budgetProfile ?? null,
    state: verdict.state,
    regionalReadiness: [...snapshot.regionalReadiness],
    utilization,
    incidentReason: verdict.reason,
    lastTransitionAt: input.database?.lastTransitionAt ?? null,
    evidenceQueryRefs: [...snapshot.evidenceQueryRefs],
  };
}

export async function reconcileReliabilityContainment(
  input: Omit<
    ReliabilityStatusInput,
    "database" | "desiredTier" | "budgetProfile"
  > & {
    readonly desiredTier: "shared" | "dedicated";
    readonly budgetProfile: string;
    readonly cellId?: string;
    readonly incidentId: string;
  },
  deps: {
    readonly metrics: MetricsQueryPort;
    readonly containment: DatabaseContainmentPort;
  }
): Promise<ReliabilityStatusV1> {
  const database = await deps.containment.status({
    nodeId: input.nodeId,
    nodeSlug: input.slug,
    environment: input.environment,
    desiredTier: input.desiredTier,
    budgetProfile: input.budgetProfile,
    ...(input.cellId ? { cellId: input.cellId } : {}),
  });
  const status = await readReliabilityStatus(
    {
      ...input,
      desiredTier: input.desiredTier,
      budgetProfile: input.budgetProfile,
      database,
    },
    deps.metrics
  );
  const reason = containmentReason(status.incidentReason);
  if (!reason || database.phase === "contained") return status;

  const contained = await deps.containment.contain({
    nodeId: input.nodeId,
    nodeSlug: input.slug,
    environment: input.environment,
    incidentId: input.incidentId,
    reason,
    actorId: "system:reliability-controller.v1",
    desiredTier: input.desiredTier,
    budgetProfile: input.budgetProfile,
    ...(input.cellId ? { cellId: input.cellId } : {}),
  });
  return {
    ...status,
    state: "contained",
    databaseTier: contained.desiredTier,
    budgetProfile: contained.budgetProfile,
    incidentReason: status.incidentReason ?? "critical policy triggered",
    lastTransitionAt: contained.lastTransitionAt,
  };
}

function containmentReason(
  reason: string | null
): DatabaseContainmentReason | null {
  if (reason?.includes("I/O pressure critical")) return "critical_io_pressure";
  if (reason?.includes("database connections critical"))
    return "critical_connections";
  if (
    reason?.includes("memory headroom critical") ||
    reason?.includes("disk headroom critical")
  )
    return "critical_headroom";
  if (reason?.includes("all readiness regions failed"))
    return "regional_readiness_failure";
  return null;
}

export function evaluateReliabilityPolicy(input: {
  readonly buildSha: string | null;
  readonly database: DatabaseContainmentStatus | null;
  readonly regionalReadiness: readonly { healthy: boolean }[];
  readonly utilization: {
    readonly ioPressurePct: number | null;
    readonly connectionPct: number | null;
    readonly memoryHeadroomPct: number | null;
    readonly diskHeadroomPct: number | null;
  };
}): { state: ReliabilityState; reason: string | null } {
  const database = input.database;
  if (database?.phase === "contained") {
    return {
      state: "contained",
      reason: database.reason ?? "database access contained",
    };
  }
  if (database?.phase === "recovering") {
    return {
      state: "recovering",
      reason: database.reason ?? "database access recovering",
    };
  }

  const values = Object.values(input.utilization);
  const hasRequiredEvidence =
    input.buildSha !== null &&
    database !== null &&
    database.desiredTier !== undefined &&
    database.budgetProfile.length > 0 &&
    input.regionalReadiness.length >= 2 &&
    values.every((value) => value !== null && Number.isFinite(value));
  if (!hasRequiredEvidence) {
    return { state: "unknown", reason: UNKNOWN_REASON };
  }

  const criticalReasons: string[] = [];
  if ((input.utilization.ioPressurePct ?? 0) >= 20)
    criticalReasons.push("I/O pressure critical");
  if ((input.utilization.connectionPct ?? 0) >= 75)
    criticalReasons.push("database connections critical");
  if ((input.utilization.memoryHeadroomPct ?? 100) <= 15)
    criticalReasons.push("memory headroom critical");
  if ((input.utilization.diskHeadroomPct ?? 100) <= 15)
    criticalReasons.push("disk headroom critical");
  if (input.regionalReadiness.every((sample) => !sample.healthy))
    criticalReasons.push("all readiness regions failed");
  if (criticalReasons.length > 0) {
    return { state: "warning", reason: criticalReasons.join("; ") };
  }

  const warningReasons: string[] = [];
  if ((input.utilization.ioPressurePct ?? 0) >= 10)
    warningReasons.push("I/O pressure warning");
  if ((input.utilization.connectionPct ?? 0) >= 60)
    warningReasons.push("database connections warning");
  if ((input.utilization.memoryHeadroomPct ?? 100) <= 25)
    warningReasons.push("memory headroom warning");
  if ((input.utilization.diskHeadroomPct ?? 100) <= 25)
    warningReasons.push("disk headroom warning");
  if (input.regionalReadiness.some((sample) => !sample.healthy))
    warningReasons.push("regional readiness degraded");
  if (warningReasons.length > 0) {
    return { state: "warning", reason: warningReasons.join("; ") };
  }

  return { state: "healthy", reason: null };
}
