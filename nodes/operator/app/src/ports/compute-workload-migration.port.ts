// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Idempotent per-bundle-digest database migration boundary for externally placed
 * workloads (bug.5116). The k3s lane runs migrations as a Deployment initContainer;
 * an external placement has no Deployment, so the controller must prove the same
 * contract before any provider mutation for a bundle digest is allowed.
 */

/**
 * One sequential migration step. Command/path policy is runtimeProfile-implied and
 * owned by the reconciler (feature layer); the adapter renders phases mechanically
 * and never decides what a profile's migrations look like.
 */
export interface ComputeWorkloadMigrationPhase {
  readonly name: string;
  readonly command: readonly string[];
  /** Key inside the node's compute env Secret projected as DATABASE_URL for this phase. */
  readonly databaseUrlSecretKey: string;
}

export interface ComputeWorkloadMigrationInput {
  readonly nodeSlug: string;
  readonly environment: string;
  /** Immutable bundle digest (`sha256:<64 hex>`) identifying migration currency. */
  readonly bundleDigest: string;
  /** Digest-pinned app artifact image — the same image the k3s initContainer ran. */
  readonly image: string;
  /** Name of the node-scoped Secret holding database URLs; values never transit the controller. */
  readonly secretName: string;
  /**
   * The namespace the Job — and therefore the migration RECEIPT — belongs to: the WORKLOAD's
   * (`cogni-<environment>`), which is also the only namespace where `secretName` exists.
   *
   * Absent means "the caller's own namespace", which is what every caller whose workloads are
   * all its own env wants (the frozen k3s controller). The ACTUATOR needs it stated: it runs in
   * the paying cluster's `cogni-production` and reconciles foreign lanes, and a Job created in
   * ITS namespace resolves `secretName` to PRODUCTION's Secret — so it would migrate production's
   * database and then leave that receipt where the lane's next pass reads it as its own
   * (task.5132). Custody decides who ACTS; the workload decides WHICH DATABASE.
   */
  readonly namespace?: string;
  readonly phases: readonly ComputeWorkloadMigrationPhase[];
}

/**
 * Level-triggered: callers re-invoke until `succeeded`. An already-succeeded digest
 * must return `succeeded` without side effects so recover replays pass instantly.
 */
export interface ComputeWorkloadMigrationPort {
  ensure(
    input: ComputeWorkloadMigrationInput
  ): Promise<"succeeded" | "running" | "failed">;
}
