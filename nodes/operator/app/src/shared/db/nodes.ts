// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/nodes`
 * Purpose: Operator-local Drizzle schema for the externally-registered node registry.
 * Scope: Environment-local projection of merged catalog nodes plus wizard working state before catalog
 *   merge. Inline and submodule nodes share this registry; git catalog intent is reconciled into it.
 * Invariants: NODES_TABLE_SCOPE (env-local catalog projection + pre-merge wizard state),
 *   STATE_MACHINE_TOTAL, OWNER_GATING, NO_PRIVATE_KEYS,
 *   OPERATOR_NODE_ROW_ID_IS_NODE_ID — `nodes.id` IS the operator's projection of the node's repo-spec
 *   `node_id` (the deployment-identity SSOT, docs/spec/identity-model.md). It is the OpenFGA `node:<id>`
 *   resource and the Loki `node` label, never an unrelated surrogate. Wizard creation's `defaultRandom()`
 *   is the act of minting that `node_id` — `publish` writes the same value into the minted repo-spec.
 *   An externally-formed node MUST be inserted with `id = <child repo-spec node_id>`, never a fresh UUID,
 *   so identity can never fork. `slug` is the human/agent addressing handle (see node-lookup.ts).
 *   CATALOG_ENVS_ARE_PROJECTED — `deploy_envs` + singleton `activity_env` + `deployment_providers`
 *   are projections of merged catalog intent. A node may deploy to many envs, but exactly one environment ingests activity and
 *   runs epoch schedules; the DB check requires that activity env to be in the deploy set.
 * Side-effects: none
 * Links: docs/spec/identity-model.md, docs/spec/node-formation.md, work/projects/proj.node-formation-ui.md, task.5083
 * @public
 */

import { users } from "@cogni/db-schema/refs";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { NodeDeploymentPlacement } from "@/shared/node-registry/placement";

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
    // OPERATOR_NODE_ROW_ID_IS_NODE_ID: this is the node's repo-spec `node_id` projection, not a private
    // surrogate. `defaultRandom()` mints it for wizard-born nodes (publish copies it into the repo-spec);
    // an external-import path must instead insert the child's repo-spec `node_id` here.
    id: uuid("id").defaultRandom().primaryKey(),
    // Human/agent addressing handle. Unique; resolve `{id}` paths by id OR slug (node-lookup.ts).
    slug: text("slug").notNull().unique(),
    // Parent deployment repo for the submodule pin PR. Slug is the unique node key.
    repoUrl: text("repo_url").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    repoVisibility: text("repo_visibility").notNull().default("public"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deployEnvs: text("deploy_envs")
      .array()
      .notNull()
      .default(sql`ARRAY['candidate-a']::text[]`),
    activityEnv: text("activity_env").notNull().default("candidate-a"),
    // CATALOG_PLACEMENT_IS_PROJECTED (bug.5106) — the node's declared per-env `deployment_provider`
    // from `infra/catalog/<slug>.yaml`, projected here so the operator can resolve WHERE a node runs
    // without reading the catalog at request time. `{}` = every env on k3s (K3S_IS_DEFAULT), so an
    // un-reconciled row keeps the historical in-cluster lane. Shape is validated on read by
    // `toNodeDeploymentPlacement` (shared/node-registry/placement.ts) — never trusted raw.
    deploymentProviders: jsonb("deployment_providers")
      .$type<NodeDeploymentPlacement>()
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    check(
      "nodes_deploy_envs_check",
      sql`${t.deployEnvs} <@ ARRAY['candidate-a','preview','production']::text[]`
    ),
    check(
      "nodes_activity_env_check",
      sql`${t.activityEnv} IN ('candidate-a','preview','production') AND ${t.activityEnv} = ANY(${t.deployEnvs})`
    ),
    index("nodes_owner_user_id_idx").on(t.ownerUserId),
    index("nodes_status_idx").on(t.status),
    index("nodes_activity_env_idx").on(t.activityEnv),
  ]
).enableRLS();
