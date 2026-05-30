// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base/schema`
 * Purpose: Base knowledge Drizzle tables (the syntropy seed bundle) inherited by every knowledge-capable node.
 *   Per-node packages re-export these tables through their own doltgres-schema entry points; drizzle-kit reads each
 *   per-node config and emits node-local migrations.
 * Scope: Drizzle table definitions only. Does not own migrations, runtime adapters, or per-node companion tables — those live elsewhere.
 * Invariants:
 *   - SCHEMA_GENERIC_CONTENT_SPECIFIC: domain specificity lives in row content (`domain` column + `tags` JSONB), not columns.
 *   - AWARENESS_HOT_KNOWLEDGE_COLD: Separate from awareness tables in Postgres.
 *   - DOLT_IS_SOURCE_OF_TRUTH (knowledge-syntropy): all knowledge data lives here. Postgres search index is derived and rebuildable.
 *   - ENTRY_HAS_PROVENANCE: every `knowledge` row has `source_type` + `source_ref`.
 *   - ENTRY_HAS_DOMAIN: every `knowledge` row's `domain` matches a registered row in `domains`.
 *   - DEPRECATE_NOT_DELETE: superseded entries get `status='deprecated'` + a `citations` row of type `supersedes`. Never DELETE.
 *   - CONFIDENCE_EVERYWHERE: every row in every knowledge table has `confidence_pct` (integer 0-100). New rows default to 40 — start low, raise as evidence accumulates. 100 is reserved for "factual and works" (objectively verifiable + currently functioning). See seed `cogni-meta-confidence-convention`.
 *   - No FK references to Postgres tables (different database server).
 *   - No RLS — access control via Doltgres roles (knowledge_reader / knowledge_writer).
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/knowledge-syntropy.md, work/items/task.0425.knowledge-contribution-api.md
 * @public
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * domains — registered knowledge domains.
 *
 * Domains are structural, not tags. Every knowledge entry belongs to exactly
 * one domain. New domains are registered explicitly (one row + one Dolt commit),
 * never created ad-hoc. FK target for `knowledge.domain`.
 */
export const domains = pgTable("domains", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  confidencePct: integer("confidence_pct").notNull().default(40),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * sources — external reference registry.
 *
 * Tracks external sources cited by knowledge entries. Enables source-reliability
 * scoring over time (a `reliability` score that's updated as sourced claims
 * are validated or contradicted).
 */
export const sources = pgTable("sources", {
  id: text("id").primaryKey(),
  url: text("url"),
  name: text("name").notNull(),
  sourceType: text("source_type").notNull(),
  confidencePct: integer("confidence_pct").notNull().default(40),
  lastAccessed: timestamp("last_accessed", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * knowledge — atomic claims and facts.
 *
 * Each row is a single assertion with provenance. The `entry_type` column
 * differentiates `observation` / `finding` / `conclusion` / `rule` / `scorecard`.
 * The `status` column drives the promotion lifecycle:
 *   draft -> candidate -> established -> canonical -> deprecated
 *
 * `source_type` enum:
 *   - human            (human-curated, initial confidence 70)
 *   - agent            (AI agent output — internal or external, initial confidence 30)
 *   - analysis_signal  (promoted from awareness pipeline, initial confidence 40)
 *   - external         (external source — paper/API/website, initial confidence 50)
 *   - derived          (computed from other knowledge, confidence inherited from cited)
 */
export const knowledge = pgTable(
  "knowledge",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    entityId: text("entity_id"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    entryType: text("entry_type").notNull().default("finding"),
    status: text("status").notNull().default("draft"),
    confidencePct: integer("confidence_pct").notNull().default(40),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref"),
    sourceNode: text("source_node"),
    tags: jsonb("tags").$type<string[]>(),
    // Hypothesis-loop columns (knowledge-syntropy.md § The Hypothesis Loop)
    // evaluateAt: REQUIRED for entry_type='hypothesis'; null otherwise.
    // Enforced at the adapter layer (HYPOTHESIS_HAS_EVALUATE_AT).
    evaluateAt: timestamp("evaluate_at", { withTimezone: true }),
    // resolutionStrategy: namespaced text on hypothesis rows. NULL = no
    // automation (cron skips). v0 non-null value: 'agent'. Future kinds
    // (market:<id>, metric:<query>, http:<url>, deadline) add new values.
    resolutionStrategy: text("resolution_strategy"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_knowledge_domain").on(table.domain),
    index("idx_knowledge_entity").on(table.entityId),
    index("idx_knowledge_source_type").on(table.sourceType),
    index("idx_knowledge_status").on(table.status),
    index("idx_knowledge_source_node").on(table.sourceNode),
    // Partial index for the resolver cron's hot query:
    //   WHERE resolution_strategy IS NOT NULL AND evaluate_at <= $now
    //         AND entry_type = 'hypothesis'
    index("idx_knowledge_resolver_due").on(
      table.evaluateAt,
      table.resolutionStrategy
    ),
  ]
);

/**
 * citations — the DAG that makes knowledge compound.
 *
 * Every edge is a directed relationship between two knowledge entries. The
 * citation DAG is what separates compounding knowledge from a flat document
 * store. Confidence recomputation walks this DAG.
 */
export const citations = pgTable(
  "citations",
  {
    id: text("id").primaryKey(),
    citingId: text("citing_id").notNull(),
    citedId: text("cited_id").notNull(),
    citationType: text("citation_type").notNull(),
    context: text("context"),
    confidencePct: integer("confidence_pct").notNull().default(40),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_citations_citing").on(table.citingId),
    index("idx_citations_cited").on(table.citedId),
    uniqueIndex("uniq_citations_edge").on(
      table.citingId,
      table.citedId,
      table.citationType
    ),
  ]
);

/**
 * knowledge_contributions — per-proposal app state for the branched contribution flow.
 *
 * Carries lifecycle + auth-context that Dolt can't hold natively (proposal state machine,
 * principal_id from bearer auth, idempotency keys, commit pointers). Dolt owns the commit
 * graph; this table owns the app-level facts Dolt doesn't know. Promoted to shared base
 * 2026-05-30 (spike.5004) — every knowledge-capable node uses the same contribution shape.
 *
 * Shape source: operator's task.0425 design (base_commit + head_commit + commit_count).
 */
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

/**
 * knowledge_contribution_commits — per-dolt-commit principal attribution.
 *
 * Bridges Dolt's commit graph (commit_hash) to Cogni's auth context (principal_id,
 * auth_source). Without this, a Dolt commit's author field carries only the db-user
 * identity, not which bearer-authenticated principal made the change. Composite PK on
 * (contribution_id, seq) preserves the order of HTTP-append events within a contribution.
 */
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

/**
 * work_items — node-local lifecycle store for tasks / bugs / spikes / stories.
 *
 * Replaces markdown-on-disk as the canonical store for newly-created work items
 * (task.0423). Promoted to shared base 2026-05-30 (spike.5004) so every knowledge-
 * capable node owns its own work_items without re-defining the schema. The
 * `node` column routes items to the responsible node; the lifecycle bag
 * (branch, pr, reviewer, revision, blockedBy, deployVerified) lets agents
 * coordinate without external tooling.
 *
 * Shape source: operator's task.0423 v0. May dissolve into `knowledge` rows with
 * `entry_type: task` / `bug` / `spike` if PR #1175 (corpus-as-knowledge) lands;
 * removal at that point is trivial.
 */
export const workItems = pgTable(
  "work_items",
  {
    // Identity
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),

    // Routing / classification
    node: text("node").notNull().default("shared"),
    projectId: text("project_id"),
    parentId: text("parent_id"),

    // Optional ranking
    priority: integer("priority"),
    rank: integer("rank"),
    estimate: integer("estimate"),

    // Free-text
    summary: text("summary"),
    outcome: text("outcome"),

    // Lifecycle bag
    branch: text("branch"),
    pr: text("pr"),
    reviewer: text("reviewer"),
    revision: integer("revision").notNull().default(0),
    blockedBy: text("blocked_by"),
    deployVerified: boolean("deploy_verified").notNull().default(false),

    // Governance runner locking (vestigial in v0)
    claimedByRun: text("claimed_by_run"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastCommand: text("last_command"),

    // Structured arrays (jsonb for v0)
    assignees: jsonb("assignees").notNull().default(sql`'[]'::jsonb`),
    externalRefs: jsonb("external_refs").notNull().default(sql`'[]'::jsonb`),
    labels: jsonb("labels").notNull().default(sql`'[]'::jsonb`),
    specRefs: jsonb("spec_refs").notNull().default(sql`'[]'::jsonb`),

    // Audit
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_work_items_type").on(t.type),
    index("idx_work_items_status").on(t.status),
    index("idx_work_items_node").on(t.node),
    index("idx_work_items_project_id").on(t.projectId),
  ]
);

export type WorkItemRow = typeof workItems.$inferSelect;
export type NewWorkItemRow = typeof workItems.$inferInsert;
