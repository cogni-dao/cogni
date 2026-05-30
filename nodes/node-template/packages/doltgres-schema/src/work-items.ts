// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-template-doltgres-schema/work-items`
 * Purpose: node-template's Doltgres `work_items` table — Dolt parity with operator (task.0423 shape). Forks of this node inherit the same source-of-truth lifecycle storage for new work items.
 * Scope: Drizzle table definition only. Targets Doltgres via pg wire protocol (dialect: postgresql).
 * Invariants:
 *   - DB_PER_NODE: this schema applies to `knowledge_node_template` only.
 *   - SCHEMA_GENERIC_CONTENT_SPECIFIC: domain-specific content lives in rows (`node`, `labels`, `spec_refs`), not columns.
 *   - NODE_NOT_NULL: `node` column is NOT NULL with default `'shared'`.
 *   - ID_RANGE_RESERVED: enforced in the adapter, not at the DB layer (allows future markdown imports without CHECK-constraint friction).
 *   - PATCH_ALLOWLIST: server-managed columns (`id`, `created_at`, `updated_at`) are not in the adapter's PATCH allowlist.
 * Side-effects: none
 * Links: docs/spec/work-items-port.md, docs/spec/knowledge-data-plane.md, work/items/task.5077.node-template-doltgres-substrate.md
 * @public
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const workItems = pgTable(
  "work_items",
  {
    // ── Identity ────────────────────────────────────────
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),

    // ── Routing / classification ────────────────────────
    node: text("node").notNull().default("shared"),
    projectId: text("project_id"),
    parentId: text("parent_id"),

    // ── Optional ranking ────────────────────────────────
    priority: integer("priority"),
    rank: integer("rank"),
    estimate: integer("estimate"),

    // ── Free-text ───────────────────────────────────────
    summary: text("summary"),
    outcome: text("outcome"),

    // ── Lifecycle bag ───────────────────────────────────
    branch: text("branch"),
    pr: text("pr"),
    reviewer: text("reviewer"),
    revision: integer("revision").notNull().default(0),
    blockedBy: text("blocked_by"),
    deployVerified: boolean("deploy_verified").notNull().default(false),

    // ── Governance runner locking (vestigial in v0) ─────
    claimedByRun: text("claimed_by_run"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastCommand: text("last_command"),

    // ── Structured arrays (jsonb for v0; broken out into
    //    relations/external-refs tables in v1) ───────────
    assignees: jsonb("assignees")
      .notNull()
      .default(sql`'[]'::jsonb`),
    externalRefs: jsonb("external_refs")
      .notNull()
      .default(sql`'[]'::jsonb`),
    labels: jsonb("labels")
      .notNull()
      .default(sql`'[]'::jsonb`),
    specRefs: jsonb("spec_refs")
      .notNull()
      .default(sql`'[]'::jsonb`),

    // ── Audit ───────────────────────────────────────────
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
  ],
);

export type WorkItemRow = typeof workItems.$inferSelect;
export type NewWorkItemRow = typeof workItems.$inferInsert;
