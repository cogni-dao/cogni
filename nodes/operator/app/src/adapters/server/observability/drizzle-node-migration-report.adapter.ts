// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/observability/drizzle-node-migration-report.adapter`
 * Purpose: Persist and serve a node's APPLIED migration receipt from the OPERATOR's own Postgres.
 * Scope: Two statements against `node_migration_reports` and nothing else; does not resolve identity,
 *   connect to any node database, hold a node DSN, or interpret drift.
 * Invariants:
 *   - ONLY_OPERATOR_POSTGRES: every statement here runs against the injected operator Drizzle
 *     client. There is no code path, and no credential, by which this adapter reaches `cogni_<node>`.
 *   - TOUCHES_NO_TENANT_TABLE: `node_migration_reports` is the ONLY table named here. `record` used
 *     to resolve `node_id` by selecting `nodes` — FORCE row-level-security tenant state — and the
 *     akash-tx actuator holds an RLS-enforced app role with no session, so that select returned zero
 *     rows for every node that exists and the receipt was never written. The caller states the
 *     receipt-bound `node_id` instead (port WRITE_KEY_IS_THE_RECEIPT_BOUND_NODE).
 *   - NO_ROW_CONTENTS_LEAK: this adapter logs nothing. Receipt payloads (tags, hashes) are returned
 *     to an authorized reader and are never written to a log line or an event by this layer.
 * Side-effects: IO (Postgres via the injected Drizzle client)
 * Links: @ports/node-migration-report.port, @shared/db/node-migration-reports,
 *   features/nodes/observability-db-schema.ts
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { and, eq } from "drizzle-orm";

import type {
  NodeMigrationReportRecord,
  NodeMigrationReportStorePort,
  RecordNodeMigrationReportInput,
  RecordNodeMigrationReportOutcome,
} from "@/ports";
import { nodeMigrationReports } from "@/shared/db/schema";
import type { AppliedMigration } from "@/shared/migrations/migration-receipt";

export class DrizzleNodeMigrationReportStore
  implements NodeMigrationReportStorePort
{
  constructor(private readonly getDb: () => Promise<Database>) {}

  async record(
    input: RecordNodeMigrationReportInput
  ): Promise<RecordNodeMigrationReportOutcome> {
    const db = await this.getDb();

    // The write key is the node id the operator's own allocation receipt already bound to this
    // workload before any Console transaction (IDENTITY_IS_AUTHORITATIVE_NOT_INFERRED). Nothing
    // on an inbound request body can name it, so a reporter still cannot write another node's
    // cell — and resolving it HERE is what silently voided every receipt, because the only
    // registry this adapter could ask is tenant-scoped and this process has no tenant.
    const row = {
      nodeId: input.nodeId,
      environment: input.environment,
      declared: input.declared,
      applied: input.applied,
      appliedCount: input.applied.length,
      bundleDigest: input.bundleDigest ?? null,
      reporter: input.reporter,
      reportedAt: new Date(),
    };

    // Current state, last-write-wins: a later deploy's receipt supersedes an earlier one.
    await db
      .insert(nodeMigrationReports)
      .values(row)
      .onConflictDoUpdate({
        target: [nodeMigrationReports.nodeId, nodeMigrationReports.environment],
        set: {
          declared: row.declared,
          applied: row.applied,
          appliedCount: row.appliedCount,
          bundleDigest: row.bundleDigest,
          reporter: row.reporter,
          reportedAt: row.reportedAt,
        },
      });
    return "recorded";
  }

  async read(input: {
    readonly nodeId: string;
    readonly environment: string;
  }): Promise<NodeMigrationReportRecord | null> {
    const db = await this.getDb();
    const [row] = await db
      .select()
      .from(nodeMigrationReports)
      .where(
        and(
          eq(nodeMigrationReports.nodeId, input.nodeId),
          eq(nodeMigrationReports.environment, input.environment)
        )
      )
      .limit(1);
    if (!row) return null;
    return {
      nodeId: row.nodeId,
      environment: row.environment,
      declared: (row.declared ?? []) as readonly string[],
      applied: (row.applied ?? []) as readonly AppliedMigration[],
      bundleDigest: row.bundleDigest,
      reporter: row.reporter,
      reportedAt: row.reportedAt.toISOString(),
    };
  }
}
