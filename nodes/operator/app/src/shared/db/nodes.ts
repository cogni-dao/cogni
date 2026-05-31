// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/nodes`
 * Purpose: Operator-local Drizzle schema for the externally-registered node registry.
 * Scope: Wizard working state for forks that target an external repo (cogni-poly first; private repos vNext).
 *   Monorepo nodes (operator/poly-in-monorepo/resy/node-template) are NOT registered here — they live in `infra/catalog/*.yaml`.
 * Invariants: NODES_TABLE_SCOPE (external only), STATE_MACHINE_TOTAL, OWNER_GATING, NO_PRIVATE_KEYS.
 * Side-effects: none
 * Links: docs/spec/node-formation.md, work/projects/proj.node-formation-ui.md, task.5083
 * @public
 */

import { users } from "@cogni/db-schema/refs";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const NODE_STATUSES = [
  "dao_pending",
  "dao_formed",
  "published",
  "wallet_ready",
  "payments_ready",
  "active",
  "failed",
] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

export const REPO_VISIBILITIES = ["public", "private"] as const;

export type RepoVisibility = (typeof REPO_VISIBILITIES)[number];

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    // Not unique: v0 monorepo-internal nodes all share Cogni-DAO/cogni. Slug is the unique key.
    repoUrl: text("repo_url").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    repoVisibility: text("repo_visibility").notNull().default("public"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("dao_pending"),
    chainId: integer("chain_id"),
    daoAddress: text("dao_address"),
    pluginAddress: text("plugin_address"),
    signalAddress: text("signal_address"),
    tokenAddress: text("token_address"),
    operatorWalletAddress: text("operator_wallet_address"),
    operatorWalletPrivyId: text("operator_wallet_privy_id"),
    splitAddress: text("split_address"),
    daoTxHash: text("dao_tx_hash"),
    signalTxHash: text("signal_tx_hash"),
    signalBlockNumber: bigint("signal_block_number", { mode: "number" }),
    splitTxHash: text("split_tx_hash"),
    publishPrUrl: text("publish_pr_url"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "nodes_status_check",
      sql`${t.status} IN ('dao_pending','dao_formed','published','wallet_ready','payments_ready','active','failed')`
    ),
    check(
      "nodes_repo_visibility_check",
      sql`${t.repoVisibility} IN ('public','private')`
    ),
    index("nodes_owner_user_id_idx").on(t.ownerUserId),
    index("nodes_status_idx").on(t.status),
  ]
).enableRLS();
