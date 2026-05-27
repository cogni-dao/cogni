// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-doltgres-schema/knowledge`
 * Purpose: Operator's Doltgres knowledge schema. Re-exports the syntropy seed
 *   bundle from @cogni/knowledge-base and owns operator-specific contribution
 *   metadata tables (knowledge_contributions, knowledge_contribution_commits).
 * Scope: Drizzle table definitions only. Targets Doltgres via pg wire protocol (dialect: postgresql).
 * Invariants:
 *   - DB_PER_NODE: this schema applies to `knowledge_operator` only.
 *   - SCHEMA_GENERIC_CONTENT_SPECIFIC: operator-specific content lives in rows (domain + tags), not columns. Add companion tables here only for genuinely new entities.
 *   - Dialect separation: this package is NOT globbed by nodes/operator/drizzle.config.ts (which targets Postgres); only by nodes/operator/drizzle.doltgres.config.ts.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/knowledge-syntropy.md, work/items/task.0425.knowledge-contribution-api.md
 * @public
 */

import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Syntropy seed bundle — shared base from @cogni/knowledge-base. Identical
// across all knowledge-capable nodes until per-node schema divergence is needed.
export {
  citations,
  domains,
  knowledge,
  sources,
} from "@cogni/knowledge-base";

export const knowledgeContributions = pgTable(
  "knowledge_contributions",
  {
    id: text("id").primaryKey(),
    branch: text("branch").notNull(),
    state: text("state").notNull(),
    principalId: text("principal_id").notNull(),
    principalKind: text("principal_kind").notNull(),
    message: text("message").notNull(),
    baseCommit: text("base_commit").notNull(),
    headCommit: text("head_commit"),
    commitCount: integer("commit_count").notNull().default(0),
    mergedCommit: text("merged_commit"),
    closedReason: text("closed_reason"),
    idempotencyKey: text("idempotency_key"),
    confidencePct: integer("confidence_pct").notNull().default(40),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (table) => [
    index("idx_kc_state").on(table.state),
    index("idx_kc_principal").on(table.principalId, table.state),
    uniqueIndex("uniq_kc_idempotency").on(
      table.principalId,
      table.idempotencyKey
    ),
  ]
);

export const knowledgeContributionCommits = pgTable(
  "knowledge_contribution_commits",
  {
    contributionId: text("contribution_id").notNull(),
    seq: integer("seq").notNull(),
    commitHash: text("commit_hash").notNull(),
    principalId: text("principal_id").notNull(),
    principalKind: text("principal_kind").notNull(),
    authSource: text("auth_source").notNull(),
    message: text("message").notNull(),
    editCount: integer("edit_count").notNull(),
    sourceRef: text("source_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "pk_kcc_contribution_seq",
      columns: [table.contributionId, table.seq],
    }),
    index("idx_kcc_commit_hash").on(table.commitHash),
  ]
);
