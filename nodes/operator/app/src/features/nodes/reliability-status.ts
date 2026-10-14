// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

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

export interface ReliabilityTarget {
  readonly nodeId: string;
  readonly slug: string;
  readonly environment: ReliabilityEnvironment;
  readonly desiredTier: "shared" | "dedicated";
  readonly budgetProfile: string;
  readonly cellId?: string;
}

export interface ReliabilitySweepResult {
  readonly target: ReliabilityTarget;
  readonly status: ReliabilityStatusV1 | null;
  readonly error: string | null;
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
    evidenceScope: snapshot.evidenceScope,
    ioPressurePct: snapshot.ioPressurePct,
    connectionPct: snapshot.connectionPct,
    memoryHeadroomPct: snapshot.memoryHeadroomPct,
    diskHeadroomPct: snapshot.diskHeadroomPct,
    databaseShare5m: snapshot.databaseShare5m,
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
  const reason = containmentReason(status);
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

/** One bounded actuator sweep. A failed target cannot suppress its neighbors. */
export async function runReliabilitySweep(
  targets: readonly ReliabilityTarget[],
  deps: {
    readonly metrics: MetricsQueryPort;
    readonly containment: DatabaseContainmentPort;
    readonly buildShaFor: (target: ReliabilityTarget) => Promise<string | null>;
    readonly incidentIdFor: (target: ReliabilityTarget) => string;
  }
): Promise<readonly ReliabilitySweepResult[]> {
  const results: ReliabilitySweepResult[] = [];
  for (const target of targets) {
    try {
      const status = await reconcileReliabilityContainment(
        {
          ...target,
          buildSha: await deps.buildShaFor(target),
          incidentId: deps.incidentIdFor(target),
        },
        deps
      );
      results.push({ target, status, error: null });
    } catch (error) {
      results.push({
        target,
        status: null,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }
  return results;
}

const NOISY_NEIGHBOR_SHARE_PCT = 40;

function containmentReason(
  status: ReliabilityStatusV1
): DatabaseContainmentReason | null {
  const reason = status.incidentReason;
  const shares = Object.values(status.utilization.databaseShare5m);
  const hasNodeAttribution =
    status.utilization.evidenceScope === "node" &&
    shares.every((value) => value !== null && Number.isFinite(value)) &&
    shares.some((value) => (value ?? 0) >= NOISY_NEIGHBOR_SHARE_PCT);
  if (!hasNodeAttribution) return null;

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
    readonly evidenceScope: "environment-shared" | "node";
    readonly ioPressurePct: number | null;
    readonly connectionPct: number | null;
    readonly memoryHeadroomPct: number | null;
    readonly diskHeadroomPct: number | null;
    readonly databaseShare5m: {
      readonly backendsPct: number | null;
      readonly physicalReadsPct: number | null;
      readonly tempBytesPct: number | null;
    };
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

  const utilizationValues = [
    input.utilization.ioPressurePct,
    input.utilization.connectionPct,
    input.utilization.memoryHeadroomPct,
    input.utilization.diskHeadroomPct,
  ];
  const databaseShares = Object.values(input.utilization.databaseShare5m);
  const hasValidAttributionEvidence =
    input.utilization.evidenceScope === "environment-shared"
      ? databaseShares.every((value) => value === null)
      : databaseShares.every(
          (value) => value !== null && Number.isFinite(value)
        );
  const hasRequiredEvidence =
    input.buildSha !== null &&
    database !== null &&
    database.desiredTier !== undefined &&
    database.budgetProfile.length > 0 &&
    input.regionalReadiness.length >= 2 &&
    utilizationValues.every(
      (value) => value !== null && Number.isFinite(value)
    ) &&
    hasValidAttributionEvidence;
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
