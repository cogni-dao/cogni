// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Environments whose database placement is governed by the operator. */
export type DatabaseEnvironment = "candidate-a" | "preview" | "production";
export type DatabaseTier = "shared" | "dedicated";
export type DatabaseCellPhase =
  | "provisioning"
  | "ready"
  | "failed"
  | "releasing"
  | "released"
  | "unknown";

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
  readonly observedAt: string;
  readonly reason?: string;
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
  readonly budgetProfile: string;
  readonly idempotencyKey: string;
  readonly storageGiB: number;
}

/** Provider lifecycle for state cells. State cells are not app workloads. */
export interface DatabaseStateCellPort {
  provision(input: ProvisionDatabaseCellInput): Promise<DatabaseCellStatus>;
  status(input: { readonly cellId: string }): Promise<DatabaseCellStatus>;
  release(input: {
    readonly cellId: string;
    readonly expectedNodeId: string;
  }): Promise<void>;
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
  readonly firewallFenced: boolean;
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
export interface DatabaseContainmentPort {
  status(input: {
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    readonly desiredTier: DatabaseTier;
    readonly budgetProfile: string;
    readonly cellId?: string;
  }): Promise<DatabaseContainmentStatus>;
  contain(input: DatabaseContainmentAction): Promise<DatabaseContainmentStatus>;
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

export interface DatabaseDsnRotationInput {
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly incidentId: string;
  readonly actorId: string;
  readonly targetCellId: string;
  readonly target: DatabaseDsnPair;
  /** Preserved-source pair used automatically if consumer verification fails. */
  readonly rollback: DatabaseDsnPair;
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
