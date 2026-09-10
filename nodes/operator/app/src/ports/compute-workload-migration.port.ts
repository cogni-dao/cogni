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
