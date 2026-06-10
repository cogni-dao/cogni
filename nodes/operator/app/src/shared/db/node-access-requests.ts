// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/node-access-requests`
 * Purpose: Tracking rows for AI-agent → node-owner access requests. UX/audit only — OpenFGA role
 *   tuples remain the sole authority (rbac.md §6); the `node.flight` check never reads this table.
 * Scope: One row per (node, agent user). `role` is the OpenFGA relation requested; v0 grants only
 *   `developer` (which confers `can_flight`). Adding `maintainer` (merge) / `releaser` (promote) is
 *   additive: extend the CHECK + the OpenFGA model. Re-requests reopen the single row to `pending`.
 * Invariants: NOT_AUTHORITY, ONE_ROW_PER_AGENT_NODE, ROLE_MAPS_TO_OPENFGA_RELATION.
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

// The OpenFGA relation a request grants. v0 = `developer` only (confers can_flight). Future roles
// (maintainer→can_merge, releaser→can_promote) are added here + in the immutable OpenFGA model.
export const NODE_ACCESS_ROLES = ["developer"] as const;

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
    unique("node_access_requests_node_agent_key").on(t.nodeId, t.agentUserId),
    check(
      "node_access_requests_status_check",
      sql`${t.status} IN ('pending','approved','denied','revoked')`
    ),
    check("node_access_requests_role_check", sql`${t.role} IN ('developer')`),
    index("node_access_requests_node_id_idx").on(t.nodeId),
    index("node_access_requests_agent_user_id_idx").on(t.agentUserId),
  ]
).enableRLS();
