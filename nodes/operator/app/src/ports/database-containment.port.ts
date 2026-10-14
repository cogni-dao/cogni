// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type { ReliabilityStatusV1 } from "@cogni/node-contracts";

/** Environments whose database placement is governed by the platform. */
export type DatabaseEnvironment = "candidate-a" | "preview" | "production";
export type DatabaseTier = "shared" | "dedicated";
export type DatabaseCellPhase =
  | "provisioning"
  | "ready"
  | "failed"
  | "releasing"
  | "released"
  | "unknown";

/** Provider-neutral resources selected from the immutable budget profile. */
export interface DatabaseCellCapacity {
  readonly vcpus: number;
  readonly memoryGiB: number;
  readonly storageGiB: number;
  readonly computeClass: "shared" | "dedicated";
}

/** Normalized provider rate captured when the cell was provisioned. */
export interface DatabaseCellCostRate {
  /** Exact compute rate for the provisioned hourly billing cycle. */
  readonly scope: "compute";
  /** Cherry publishes only a floor, not an exact SKU/region storage quote. */
  readonly complete: false;
  readonly unquotedComponents: readonly ["exact-storage"];
  readonly amount: number;
  /** Hourly compute normalized to 730 hours; not Cherry's alternate monthly cycle. */
  readonly monthlyAmount: number;
  readonly providerMonthlyCycleAmount: number;
  readonly currency: "EUR" | "USD";
  readonly unit: "hour";
  readonly capturedAt: string;
  readonly storageMinimumEstimate: {
    readonly kind: "provider-published-floor";
    readonly perGiBMonthlyAmount: number;
    readonly monthlyMinimumAmount: number;
    readonly sourceUrl: string;
    readonly fetchedAt: string;
  };
}

/** Durable allocation receipt. Provider SKU values are opaque identifiers. */
export interface DatabaseCellAllocation {
  readonly budgetProfile: string;
  readonly capacity: DatabaseCellCapacity;
  readonly providerProjectId: string;
  readonly providerRegion: string;
  readonly imageRef: string;
  readonly reviewedBuildSha: string;
  readonly computeSku: string;
  readonly storageSku: string;
  readonly costRate: DatabaseCellCostRate;
}

export interface DatabaseCellStatus {
  readonly provider: string;
  readonly cellId: string;
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly phase: DatabaseCellPhase;
  /** Provider endpoint only; credentials never cross this port. */
  readonly endpoint: string | null;
  readonly storage: {
    readonly volumeId: string;
    readonly sizeGiB: number;
  } | null;
  readonly allocation: DatabaseCellAllocation;
  /** Non-null only after endpoint reachability and deterministic DB verification. */
  readonly verification: DatabaseCellActionReceipt["verification"] | null;
  readonly observedAt: string;
  readonly reason?: string;
}

export interface DatabaseCellActionReceipt {
  readonly provider: string;
  readonly cellId: string;
  readonly nodeId: string;
  readonly actorId: string;
  readonly reviewedBuildSha: string;
  readonly action: "backup" | "restore";
  /** Caller-generated immutable backup label; contains no credentials. */
  readonly backupLabel: string;
  readonly acceptedAt: string;
  /** Provider action identity polled to terminal success. */
  readonly providerActionId: string;
  /** Exact immutable restore point created/consumed by this action. */
  readonly restorePointId: string;
  readonly completedAt: string;
  /** Database-level verification after the provider operation completed. */
  readonly verification: {
    readonly schemaFingerprint: string;
    readonly rowCount: number;
    readonly checksum: string;
  };
}

/**
 * The complete, bounded Prometheus identity for one database failure domain.
 * Provider IDs, endpoints, incident IDs, and replay IDs are intentionally not
 * labels: `nodeSlug` distinguishes Poly's dedicated cell from the shared host.
 */
export interface DatabaseCellMetricIdentity {
  readonly environment: DatabaseEnvironment;
  readonly nodeSlug: string;
  readonly databaseTier: DatabaseTier;
  readonly budgetProfile: string;
  readonly state: "provisioning" | "ready" | "failed" | "released" | "unknown";
}

export const DATABASE_CELL_METRIC_LABEL_KEYS = [
  "environment",
  "node_slug",
  "database_tier",
  "budget_profile",
  "state",
] as const;

export interface DatabaseCellMetricsTarget {
  /** Control-plane selector only; exporters MUST NOT emit it as a metric label. */
  readonly cellId: string;
  /** Private scrape endpoint; never returned by a public status route. */
  readonly scrapeUrl: string;
  readonly identity: DatabaseCellMetricIdentity;
}

/** Reconciles dedicated-cell scrape discovery without owning alert policy. */
export interface DatabaseCellMetricsExporterPort {
  reconcileTarget(target: DatabaseCellMetricsTarget): Promise<void>;
  removeTarget(input: { readonly cellId: string }): Promise<void>;
}

export interface ProvisionDatabaseCellInput {
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly databaseTier: "dedicated";
  readonly budgetProfile: string;
  readonly idempotencyKey: string;
}

/** Provider lifecycle for state cells. State cells are not app workloads. */
export interface DatabaseStateCellPort {
  provision(input: ProvisionDatabaseCellInput): Promise<DatabaseCellStatus>;
  status(input: { readonly cellId: string }): Promise<DatabaseCellStatus>;
  release(input: {
    readonly cellId: string;
    readonly expectedNodeId: string;
  }): Promise<void>;
  backup(input: {
    readonly cellId: string;
    readonly expectedNodeId: string;
    readonly actorId: string;
    readonly backupLabel: string;
  }): Promise<DatabaseCellActionReceipt>;
  restore(input: {
    readonly cellId: string;
    readonly expectedNodeId: string;
    readonly actorId: string;
    readonly backupLabel: string;
  }): Promise<DatabaseCellActionReceipt>;
}

export type DatabaseContainmentReason =
  | "critical_io_pressure"
  | "critical_connections"
  | "critical_headroom"
  | "regional_readiness_failure"
  | "operator_action";

export interface DatabaseContainmentStatus {
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly desiredTier: DatabaseTier;
  readonly budgetProfile: string;
  readonly contained: boolean;
  readonly phase: "open" | "contained" | "recovering";
  readonly activeSessions: number;
  readonly rolesPresent: boolean;
  readonly rolesCanLogin: boolean;
  /** Manual-secondary firewall observation; null when no read-only observer is wired. */
  readonly firewallFenced: boolean | null;
  readonly cell: DatabaseCellStatus | null;
  readonly observedAt: string;
  readonly lastTransitionAt: string | null;
  readonly incidentId: string | null;
  readonly reason: DatabaseContainmentReason | null;
}

export interface DatabasePlacementResolverPort {
  resolve(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    /** Immutable deployed source. Reliability callers must never read mutable main. */
    readonly sourceRef: string;
  }): Promise<{
    readonly nodeId: string;
    readonly desiredTier: DatabaseTier;
    readonly budgetProfile: string;
  }>;
}

export interface DatabaseContainmentAction {
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly incidentId: string;
  readonly reason: DatabaseContainmentReason;
  readonly actorId: string;
  readonly desiredTier: DatabaseTier;
  readonly budgetProfile: string;
  readonly cellId?: string;
}

/**
 * Typed action/status seam consumed by reliability policy. Implementations own
 * SQL sessions and source-specific firewall state; callers never receive admin DSNs.
 */
export interface DatabaseContainmentStatusPort {
  status(input: {
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    readonly desiredTier: DatabaseTier;
    readonly budgetProfile: string;
    readonly cellId?: string;
  }): Promise<DatabaseContainmentStatus>;
}

/** Autonomous sweep capability: status + NOLOGIN/session drain only. */
export interface DatabaseContainmentPort extends DatabaseContainmentStatusPort {
  contain(input: DatabaseContainmentAction): Promise<DatabaseContainmentStatus>;
}

/** Human-gated capability: LOGIN only; never mounted in the sweep process. */
export interface DatabaseReadmissionPort {
  readmit(input: DatabaseContainmentAction): Promise<DatabaseContainmentStatus>;
}

export interface DatabaseDsnPair {
  readonly app: string;
  readonly service: string;
}

export interface DatabaseRuntimeSecretSyncPort {
  forceAndWait(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    readonly openBaoVersion: number;
  }): Promise<{ readonly receiptId: string }>;
}

export interface DatabaseDsnSecretsReadInput {
  readonly nodeSlug: string;
  readonly service?: string | undefined;
  readonly env: string;
  readonly keys: readonly string[];
}

export interface DatabaseDsnSecretsReadResult {
  readonly version: number;
  readonly path: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface DatabaseDsnSecretsWriteResult {
  readonly written: boolean;
  readonly version: number;
  readonly path: string;
  readonly keys: readonly string[];
}

/** Atomic KV-v2 capability required only by database DSN rotation. */
export interface DatabaseDsnSecretsPlanePort {
  readSecrets(
    input: DatabaseDsnSecretsReadInput
  ): Promise<DatabaseDsnSecretsReadResult>;
  compareAndSwapSecrets(input: {
    readonly nodeSlug: string;
    readonly service?: string | undefined;
    readonly env: string;
    readonly expectedVersion: number;
    readonly values: Readonly<Record<string, string>>;
  }): Promise<DatabaseDsnSecretsWriteResult>;
}

export interface DatabaseDsnRotationInput {
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly incidentId: string;
  readonly actorId: string;
  readonly targetCellId: string;
  /** Provider-observed hostname/IP for targetCellId; both DSNs must match it. */
  readonly targetCellEndpoint: string;
  readonly target: DatabaseDsnPair;
}

export interface DatabaseDsnRotationResult {
  readonly openBaoVersion: number;
  readonly syncReceiptId: string;
  readonly targetCellId: string;
  readonly endpointFingerprint: string;
}

export interface DatabaseDsnRotationPort {
  rotate(input: DatabaseDsnRotationInput): Promise<DatabaseDsnRotationResult>;
}

/** Read-only public-app seam to the private reliability controller. */
export interface ReliabilityStatusReaderPort {
  read(input: {
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
  }): Promise<ReliabilityStatusV1>;
}

/** Narrow human command seam; actor identity is supplied by authenticated app code. */
export interface ReliabilityReadmitPort {
  readmit(input: {
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    readonly actorId: string;
    readonly incidentId: string;
  }): Promise<{
    readonly phase: "open";
    readonly incidentId: string | null;
    readonly lastTransitionAt: string | null;
  }>;
}
