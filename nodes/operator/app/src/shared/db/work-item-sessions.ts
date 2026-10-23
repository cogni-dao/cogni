// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/work-item-sessions`
 * Purpose: Operator-local Drizzle schema for active work-item coordination.
 * Scope: Hot operational session state only. Work item lifecycle state remains
 *   in Doltgres and is referenced by id, never FK'd across databases.
 * Invariants: DOLT_IS_SOURCE_OF_TRUTH, OPERATOR_COORDINATION_LOCAL,
 *   EXACTLY_ONE_CLAIMANT (a human `users.id` or a durable agent principal id,
 *   never both and never an agent projected into `users`).
 * Side-effects: none
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

import { users } from "@cogni/db-schema/refs";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const WORK_ITEM_SESSION_STATUSES = [
  "active",
  "idle",
  "stale",
  "closed",
  "superseded",
] as const;

export type WorkItemSessionStatus = (typeof WORK_ITEM_SESSION_STATUSES)[number];

export const workItemSessions = pgTable(
  "work_item_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workItemId: text("work_item_id").notNull(),
    claimedByUserId: text("claimed_by_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    /** Durable agent principal (`agent:<node>/<actorId>`); null for humans. */
    claimedByPrincipalId: text("claimed_by_principal_id"),
    claimedByDisplayName: text("claimed_by_display_name"),
    status: text("status").notNull().default("active"),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lastCommand: text("last_command"),
    branch: text("branch"),
    prNumber: integer("pr_number"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "work_item_sessions_status_check",
      sql`${table.status} IN ('active','idle','stale','closed','superseded')`
    ),
    check(
      "work_item_sessions_exactly_one_claimant_check",
      sql`num_nonnulls(${table.claimedByUserId}, ${table.claimedByPrincipalId}) = 1`
    ),
    check(
      "work_item_sessions_principal_is_agent_check",
      sql`${table.claimedByPrincipalId} IS NULL OR ${table.claimedByPrincipalId} LIKE 'agent:%'`
    ),
    index("work_item_sessions_work_item_id_idx").on(table.workItemId),
    index("work_item_sessions_claimed_by_user_idx").on(table.claimedByUserId),
    uniqueIndex("work_item_sessions_one_open_claim_idx")
      .on(table.workItemId)
      .where(sql`${table.status} IN ('active','idle')`),
  ]
).enableRLS();
