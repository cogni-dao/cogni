// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/node-access-requests`
 * Purpose: Tracking rows for AI-agent → node-owner access requests. UX/audit only — OpenFGA role
 *   tuples remain the sole authority (rbac.md §6); the `node.flight` check never reads this table.
 * Scope: One row per (node, agent user). `role` is the OpenFGA relation requested. v0 grants
 *   `developer` (confers `can_flight`, candidate-a) or `production_promoter` (confers
 *   `can_promote_production`). Adding a role (e.g. `preview_promoter` → `can_promote_preview`) is
 *   additive: extend NODE_ACCESS_ROLES + the CHECK + the OpenFGA model. Re-requests reopen the row.
 * Invariants: NOT_AUTHORITY, ONE_ROW_PER_AGENT_NODE_ROLE (an agent can request multiple roles on
 *   one node — each is its own row), ROLE_MAPS_TO_OPENFGA_RELATION.
 * Side-effects: none
 * Links: docs/spec/rbac.md §6, docs/spec/identity-model.md
 * @public
 */

import { users } from "@cogni/db-schema/refs";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { nodes } from "./nodes";

export const NODE_ACCESS_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "revoked",
] as const;

export type NodeAccessRequestStatus =
  (typeof NODE_ACCESS_REQUEST_STATUSES)[number];

// The OpenFGA relation a request grants — one distinct, least-privilege role per
// capability. `developer`→can_flight (candidate-a); `secrets_manager`→can_manage_secrets;
// `production_promoter`→can_promote_production (production). A new role is added here +
// in the immutable OpenFGA model + the CHECK below.
export const NODE_ACCESS_ROLES = [
  "developer",
  "secrets_manager",
  "production_promoter",
] as const;

export type NodeAccessRole = (typeof NODE_ACCESS_ROLES)[number];

export const nodeAccessRequests = pgTable(
  "node_access_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    agentUserId: text("agent_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("developer"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("node_access_requests_node_agent_role_key").on(
      t.nodeId,
      t.agentUserId,
      t.role
    ),
    check(
      "node_access_requests_status_check",
      sql`${t.status} IN ('pending','approved','denied','revoked')`
    ),
    check(
      "node_access_requests_role_check",
      sql`${t.role} IN ('developer','secrets_manager','production_promoter')`
    ),
    index("node_access_requests_node_id_idx").on(t.nodeId),
    index("node_access_requests_agent_user_id_idx").on(t.agentUserId),
  ]
).enableRLS();
