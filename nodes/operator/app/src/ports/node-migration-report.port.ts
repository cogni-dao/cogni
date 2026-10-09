// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/node-migration-report.port`
 * Purpose: The boundary for APPLIED migration state as operator-held deployment metadata.
 * Scope: Record one receipt / read one cell. Does not run migrations, does not reach a node
 *   database, and does not decide what drift means — the gate is the caller's policy.
 * Invariants:
 *   - WRITE_KEY_IS_DERIVED_NEVER_SUPPLIED: `record` takes the WORKLOAD the operator is already
 *     reconciling (`nodeSlug` + `environment`) and the implementation resolves `node_id` from the
 *     operator's own registry. No caller can name another node's cell.
 *   - READS_ARE_OPERATOR_LOCAL: `read` answers from operator Postgres only; a missing cell is
 *     `null` (never reported), which is NOT the same as a cell whose `applied` is empty.
 * Side-effects: none
 * Links: adapters/server/observability/drizzle-node-migration-report.adapter.ts,
 *   shared/migrations/migration-receipt.ts, docs/spec/cicd-platform-boundary.md (OPERATOR_PLANE_CONTRACT)
 * @public
 */

import type { AppliedMigration } from "@/shared/migrations/migration-receipt";

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
  /** The workload slug being reconciled — resolved to `node_id` by the implementation. */
  readonly nodeSlug: string;
  readonly environment: string;
  readonly declared: readonly string[];
  readonly applied: readonly AppliedMigration[];
  readonly bundleDigest?: string | undefined;
  readonly reporter: string;
}

/** Why a `record` call did not land. Enumerated so the caller can log an enum, never a row. */
export type RecordNodeMigrationReportOutcome =
  | "recorded"
  | "node_not_registered";

export interface NodeMigrationReportStorePort {
  /** Upsert the `(node_id, environment)` cell. Resolves `node_id` itself; never trusts a caller's. */
  record(
    input: RecordNodeMigrationReportInput
  ): Promise<RecordNodeMigrationReportOutcome>;
  /** The one cell, or null when this node has NEVER reported in this environment. */
  read(input: {
    readonly nodeId: string;
    readonly environment: string;
  }): Promise<NodeMigrationReportRecord | null>;
}
