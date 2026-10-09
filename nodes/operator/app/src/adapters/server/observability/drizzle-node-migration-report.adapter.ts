// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/observability/drizzle-node-migration-report.adapter`
 * Purpose: Persist and serve a node's APPLIED migration receipt from the OPERATOR's own Postgres.
 * Scope: Two statements against `node_migration_reports` plus one slug lookup against `nodes`; does not
 *   connect to any node database, hold a node DSN, or interpret drift.
 * Invariants:
 *   - ONLY_OPERATOR_POSTGRES: every statement here runs against the injected operator Drizzle
 *     client. There is no code path, and no credential, by which this adapter reaches `cogni_<node>`.
 *   - NODE_ID_IS_RESOLVED_HERE: `record` is handed a workload slug and resolves `node_id` from the
 *     operator registry itself, so the stored key cannot be influenced by the reporter. An
 *     unregistered slug is reported as `node_not_registered` and writes NOTHING.
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
import { nodeMigrationReports, nodes } from "@/shared/db/schema";
import type { AppliedMigration } from "@/shared/migrations/migration-receipt";

export class DrizzleNodeMigrationReportStore
  implements NodeMigrationReportStorePort
{
  constructor(private readonly getDb: () => Promise<Database>) {}

  async record(
    input: RecordNodeMigrationReportInput
  ): Promise<RecordNodeMigrationReportOutcome> {
    const db = await this.getDb();

    // The write key is DERIVED, never supplied: the reporter names the workload it migrated and
    // the operator's own registry says which node_id that is. A reporter therefore cannot write
    // another node's cell even if it wanted to — there is no field on the wire that would let it.
    const [registryRow] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.slug, input.nodeSlug))
      .limit(1);
    if (!registryRow) return "node_not_registered";

    const row = {
      nodeId: registryRow.id,
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
