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
import { RELIABILITY_POLICY_V1 } from "@cogni/node-contracts";

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
  readonly sourceSha: string;
  readonly cellId?: string;
}

export interface ReliabilitySweepResult {
  readonly target: ReliabilityTarget;
  readonly status: ReliabilityStatusV1 | null;
  readonly error: string | null;
}

const UNKNOWN_REASON = "required reliability evidence is missing";
export const EXPECTED_RELIABILITY_REGIONS =
  RELIABILITY_POLICY_V1.expectedRegions;
export const RELIABILITY_EVIDENCE_TTL_MS = RELIABILITY_POLICY_V1.evidenceTtlMs;

export function isReliabilitySweepReady(input: {
  readonly nowMs: number;
  readonly lastCompleteSweepAt: number | null;
  readonly targetKeys: ReadonlySet<string>;
  readonly statusKeys: ReadonlySet<string>;
}): boolean {
  return (
    input.lastCompleteSweepAt !== null &&
    input.nowMs - input.lastCompleteSweepAt <= RELIABILITY_EVIDENCE_TTL_MS &&
    input.targetKeys.size > 0 &&
    input.targetKeys.size === input.statusKeys.size &&
    [...input.targetKeys].every((key) => input.statusKeys.has(key))
  );
}

export async function readReliabilityStatus(
  input: ReliabilityStatusInput,
  metrics: MetricsQueryPort
): Promise<ReliabilityStatusV1> {
  const observedAt = new Date().toISOString();
  const buildSha =
    input.buildSha && /^[0-9a-f]{40}$/.test(input.buildSha)
      ? input.buildSha
      : null;
  const snapshot = await metrics.queryReliabilitySnapshot({
    nodeSlug: input.slug,
    environment: input.environment,
    databaseTier: input.desiredTier,
    budgetProfile: input.budgetProfile,
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
    buildSha,
    database: input.database,
    regionalReadiness: snapshot.regionalReadiness,
    utilization,
    observedAt,
  });

  return {
    version: "reliability-status.v1",
    nodeId: input.nodeId,
    slug: input.slug,
    environment: input.environment,
    buildSha,
    databaseTier: input.database?.desiredTier ?? input.desiredTier ?? "unknown",
    budgetProfile: input.database?.budgetProfile ?? input.budgetProfile ?? null,
    state: verdict.state,
    regionalReadiness: [...snapshot.regionalReadiness],
    utilization,
    incidentReason: verdict.reason,
    observedAt,
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
    readonly sourceSha: string;
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
  if (status.buildSha !== input.sourceSha) {
    return {
      ...status,
      state: "unknown",
      incidentReason: "deployed build does not match immutable catalog target",
    };
  }
  if (input.desiredTier === "dedicated") {
    return {
      ...status,
      state: "unknown",
      incidentReason:
        "dedicated database cell telemetry is not node-attributed",
    };
  }
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

const NOISY_NEIGHBOR_SHARE_PCT =
  RELIABILITY_POLICY_V1.noisyNeighborSharePercent;

function containmentReason(
  status: ReliabilityStatusV1
): DatabaseContainmentReason | null {
  const reason = status.incidentReason;
  const shares = status.utilization.databaseShare5m;
  const shareValues = Object.values(shares);
  const hasNodeAttribution =
    status.utilization.evidenceScope === "node" &&
    shareValues.every((value) => value !== null && Number.isFinite(value));
  if (!hasNodeAttribution) return null;

  if (
    reason?.includes("I/O pressure critical") &&
    ((shares.physicalReadsPct ?? 0) >= NOISY_NEIGHBOR_SHARE_PCT ||
      (shares.tempBytesPct ?? 0) >= NOISY_NEIGHBOR_SHARE_PCT)
  ) {
    return "critical_io_pressure";
  }
  if (
    reason?.includes("database connections critical") &&
    (shares.backendsPct ?? 0) >= NOISY_NEIGHBOR_SHARE_PCT
  ) {
    return "critical_connections";
  }
  // Host memory/disk and regional availability have no causal per-database
  // series in v1. They page a human but must never mutate a node role.
  return null;
}

export function evaluateReliabilityPolicy(input: {
  readonly buildSha: string | null;
  readonly database: DatabaseContainmentStatus | null;
  readonly regionalReadiness: readonly {
    readonly region: string;
    readonly healthy: boolean;
    readonly observedAt: string;
  }[];
  readonly observedAt?: string;
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
  const observedAtMs = Date.parse(input.observedAt ?? new Date().toISOString());
  const expectedRegions = new Set<string>(EXPECTED_RELIABILITY_REGIONS);
  const readinessRegions = new Set(
    input.regionalReadiness.map((sample) => sample.region)
  );
  const hasExactFreshReadiness =
    input.regionalReadiness.length === EXPECTED_RELIABILITY_REGIONS.length &&
    readinessRegions.size === EXPECTED_RELIABILITY_REGIONS.length &&
    [...readinessRegions].every((region) => expectedRegions.has(region)) &&
    input.regionalReadiness.every((sample) => {
      const sampledAtMs = Date.parse(sample.observedAt);
      return (
        Number.isFinite(sampledAtMs) &&
        sampledAtMs <= observedAtMs + 15_000 &&
        observedAtMs - sampledAtMs <= RELIABILITY_EVIDENCE_TTL_MS
      );
    });
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
    hasExactFreshReadiness &&
    utilizationValues.every(
      (value) => value !== null && Number.isFinite(value)
    ) &&
    hasValidAttributionEvidence;
  if (!hasRequiredEvidence) {
    return { state: "unknown", reason: UNKNOWN_REASON };
  }

  const criticalReasons: string[] = [];
  if (
    (input.utilization.ioPressurePct ?? 0) >=
    RELIABILITY_POLICY_V1.signals.ioPressurePercent.critical
  )
    criticalReasons.push("I/O pressure critical");
  if (
    (input.utilization.connectionPct ?? 0) >=
    RELIABILITY_POLICY_V1.signals.connectionsPercent.critical
  )
    criticalReasons.push("database connections critical");
  if (
    (input.utilization.memoryHeadroomPct ?? 100) <=
    RELIABILITY_POLICY_V1.signals.memoryHeadroomPercent.critical
  )
    criticalReasons.push("memory headroom critical");
  if (
    (input.utilization.diskHeadroomPct ?? 100) <=
    RELIABILITY_POLICY_V1.signals.diskHeadroomPercent.critical
  )
    criticalReasons.push("disk headroom critical");
  if (input.regionalReadiness.every((sample) => !sample.healthy))
    criticalReasons.push("all readiness regions failed");
  if (criticalReasons.length > 0) {
    return { state: "warning", reason: criticalReasons.join("; ") };
  }

  const warningReasons: string[] = [];
  if (
    (input.utilization.ioPressurePct ?? 0) >=
    RELIABILITY_POLICY_V1.signals.ioPressurePercent.warning
  )
    warningReasons.push("I/O pressure warning");
  if (
    (input.utilization.connectionPct ?? 0) >=
    RELIABILITY_POLICY_V1.signals.connectionsPercent.warning
  )
    warningReasons.push("database connections warning");
  if (
    (input.utilization.memoryHeadroomPct ?? 100) <=
    RELIABILITY_POLICY_V1.signals.memoryHeadroomPercent.warning
  )
    warningReasons.push("memory headroom warning");
  if (
    (input.utilization.diskHeadroomPct ?? 100) <=
    RELIABILITY_POLICY_V1.signals.diskHeadroomPercent.warning
  )
    warningReasons.push("disk headroom warning");
  if (input.regionalReadiness.some((sample) => !sample.healthy))
    warningReasons.push("regional readiness degraded");
  if (warningReasons.length > 0) {
    return { state: "warning", reason: warningReasons.join("; ") };
  }

  return { state: "healthy", reason: null };
}
