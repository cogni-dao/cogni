// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/node-migration-reports`
 * Purpose: Operator-local Drizzle schema for APPLIED migration state.
 * Scope: Defines node_migration_reports only; does not hold queries, gate policy, a node DSN, or any
 *   node DATA — only the node's own migrator's receipt about its own schema.
 * Invariants:
 *   - METADATA_NOT_DATA_ACCESS: these rows are REPORTED to the operator by the node's own migrator.
 *     The operator never connects to `cogni_<node>` to populate them (docs/spec/multi-node-tenancy.md
 *     NO_CROSS_NODE_QUERIES / OPERATOR_READS_NODE_VIA_VCS). A read here is a read of operator Postgres.
 *   - KEY_IS_THE_DEPLOYMENT_CELL: the primary key is `(node_id, environment)` — one node's schema state
 *     in one environment. `node_id` is the immutable repo-spec UUID used strictly as infrastructure /
 *     DB-tenancy identity (docs/spec/identity-model.md); a renameable slug is never the key.
 *   - ABSENCE_IS_NOT_SUCCESS: no row means "this node has never reported". A reported node with an
 *     empty `applied` array is a DIFFERENT, representable fact, so silence can never read as green.
 * Side-effects: none
 * Links: adapters/server/observability/drizzle-node-migration-report.adapter.ts,
 *   shared/migrations/migration-receipt.ts, docs/spec/databases.md § 2 Migration Strategy
 * @public
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { AppliedMigration } from "@/shared/migrations/migration-receipt";

/**
 * The latest migration receipt for one `(node_id, environment)` deployment cell.
 *
 * Last-write-wins by design: this is CURRENT STATE, not a history — the question it answers is
 * "what is in that database now", and the authoritative history is the node's own drizzle ledger.
 * Deliberately NOT a foreign key to `nodes`, for the same reason `akash_tx_allocations.node_id`
 * is not: purging a registry row must not be able to delete the evidence of what was deployed.
 */
export const nodeMigrationReports = pgTable(
  "node_migration_reports",
  {
    /** The immutable repo-spec node UUID — infrastructure identity only. */
    nodeId: uuid("node_id").notNull(),
    /** The deploy environment whose database this receipt describes. */
    environment: text("environment").notNull(),
    /** Journal tags the reporting image DECLARED, in journal order (`string[]`). */
    declared: jsonb("declared").$type<readonly string[]>().notNull(),
    /** Rows drizzle actually holds, oldest first (`AppliedMigration[]`). */
    applied: jsonb("applied").$type<readonly AppliedMigration[]>().notNull(),
    /** `applied.length`, denormalized so a gate can read a count without parsing jsonb. */
    appliedCount: integer("applied_count").notNull(),
    /** Image bundle digest the receipt came from, when the reporter knew it. Observability only. */
    bundleDigest: text("bundle_digest"),
    /** Where the receipt was collected from — `migration-job` today; an HTTP reporter later. */
    reporter: text("reporter").notNull(),
    /** When the operator stored this receipt (NOT when the migrations ran). */
    reportedAt: timestamp("reported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "node_migration_reports_pkey",
      columns: [table.nodeId, table.environment],
    }),
    index("node_migration_reports_reported_at_idx").on(table.reportedAt),
  ]
);
