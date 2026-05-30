// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/work-item-sessions`
 * Purpose: Operator-local Drizzle schema for active work-item coordination.
 * Scope: Hot operational session state only. Work item lifecycle state remains
 *   in Doltgres and is referenced by id, never FK'd across databases.
 * Invariants: DOLT_IS_SOURCE_OF_TRUTH, OPERATOR_COORDINATION_LOCAL.
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
    claimedByUserId: text("claimed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    repoFullName: text("repo_full_name"),
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
    index("work_item_sessions_work_item_id_idx").on(table.workItemId),
    index("work_item_sessions_claimed_by_user_idx").on(table.claimedByUserId),
    uniqueIndex("work_item_sessions_one_open_claim_idx")
      .on(table.workItemId)
      .where(sql`${table.status} IN ('active','idle')`),
    uniqueIndex("work_item_sessions_one_session_per_pr_idx")
      .on(table.repoFullName, table.prNumber)
      .where(
        sql`${table.status} IN ('active','idle') AND ${table.repoFullName} IS NOT NULL AND ${table.prNumber} IS NOT NULL`
      ),
  ]
).enableRLS();
