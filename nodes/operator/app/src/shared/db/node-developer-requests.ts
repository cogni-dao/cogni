// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/node-developer-requests`
 * Purpose: Tracking rows for AI-agent → node-owner developer-access requests. UX/audit only —
 *   OpenFGA `developer` tuples remain the sole flight authority (rbac.md §6); the `node.flight`
 *   check never reads this table.
 * Scope: One row per (node, agent user). Owner sees pending/approved/denied/revoked here; re-requests
 *   reopen the single row to `pending`.
 * Invariants: NOT_AUTHORITY, ONE_ROW_PER_AGENT_NODE, FLIGHT_ONLY_SCOPE_V0.
 * Side-effects: none
 * Links: docs/spec/rbac.md §6
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

export const NODE_DEVELOPER_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "revoked",
] as const;

export type NodeDeveloperRequestStatus =
  (typeof NODE_DEVELOPER_REQUEST_STATUSES)[number];

// v0 grants flight-to-candidate only. Leave the column so vNext can add
// promote/secrets scopes without a migration churn; behavior stays node.flight.
export const NODE_DEVELOPER_REQUEST_SCOPES = ["flight"] as const;

export type NodeDeveloperRequestScope =
  (typeof NODE_DEVELOPER_REQUEST_SCOPES)[number];

export const nodeDeveloperRequests = pgTable(
  "node_developer_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    agentUserId: text("agent_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("flight"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("node_developer_requests_node_agent_key").on(
      t.nodeId,
      t.agentUserId
    ),
    check(
      "node_developer_requests_status_check",
      sql`${t.status} IN ('pending','approved','denied','revoked')`
    ),
    check("node_developer_requests_scope_check", sql`${t.scope} IN ('flight')`),
    index("node_developer_requests_node_id_idx").on(t.nodeId),
    index("node_developer_requests_agent_user_id_idx").on(t.agentUserId),
  ]
).enableRLS();
