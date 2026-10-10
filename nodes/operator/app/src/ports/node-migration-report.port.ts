// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/node-migration-report.port`
 * Purpose: The boundary for APPLIED migration state as operator-held deployment metadata.
 * Scope: Record one receipt / read one cell. Does not run migrations, does not reach a node
 *   database, and does not decide what drift means — the gate is the caller's policy.
 * Invariants:
 *   - WRITE_KEY_IS_THE_RECEIPT_BOUND_NODE: `record` is handed the `node_id` the operator's OWN
 *     durable allocation receipt already binds to the workload being reconciled — the write-once
 *     UUID the spend for that same workload is attributed to. It is never a slug, never parsed out
 *     of `cogniKey`, and never re-derived from the `nodes` registry: that table is FORCE
 *     row-level-security tenant state, so an operator-internal writer holding no user session sees
 *     ZERO rows there and could only ever report "not registered" for every node that exists.
 *   - READS_ARE_OPERATOR_LOCAL: `read` answers from operator Postgres only; a missing cell is
 *     `null` (never reported), which is NOT the same as a cell whose `applied` is empty.
 * Side-effects: none
 * Links: adapters/server/observability/drizzle-node-migration-report.adapter.ts,
 *   shared/migrations/migration-receipt.ts, docs/spec/cicd-platform-boundary.md (OPERATOR_PLANE_CONTRACT)
 * @public
 */

import type { AppliedMigration } from "@/types/migration-receipt";

/** One stored receipt, as the read path sees it. */
export interface NodeMigrationReportRecord {
  readonly nodeId: string;
  readonly environment: string;
  readonly declared: readonly string[];
  readonly applied: readonly AppliedMigration[];
  readonly bundleDigest: string | null;
  readonly reporter: string;
  readonly reportedAt: string;
}

/** What a reporter hands over after a successful migrate. */
export interface RecordNodeMigrationReportInput {
  /**
   * The immutable repo-spec node UUID for the workload that just migrated, as the operator's
   * own durable allocation receipt binds it. Resolved by the reconcile path from the receipt,
   * NOT from anything on a request body — see WRITE_KEY_IS_THE_RECEIPT_BOUND_NODE.
   */
  readonly nodeId: string;
  readonly environment: string;
  readonly declared: readonly string[];
  readonly applied: readonly AppliedMigration[];
  readonly bundleDigest?: string | undefined;
  readonly reporter: string;
}

/**
 * How a `record` call landed. Still an enum so the caller logs an enum and never a row — and
 * still a union, deliberately: `node_not_registered` was retired with the registry lookup that
 * produced it, and the next member will be a storage outcome, never an identity one.
 */
export type RecordNodeMigrationReportOutcome = "recorded";

export interface NodeMigrationReportStorePort {
  /** Upsert the `(node_id, environment)` cell from the receipt-bound node id. */
  record(
    input: RecordNodeMigrationReportInput
  ): Promise<RecordNodeMigrationReportOutcome>;
  /** The one cell, or null when this node has NEVER reported in this environment. */
  read(input: {
    readonly nodeId: string;
    readonly environment: string;
  }): Promise<NodeMigrationReportRecord | null>;
}
