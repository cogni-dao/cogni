// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Root-owned administrative Postgres schema. It intentionally lives outside the
 * app schema glob/barrel: global role admission and incident intent must commit
 * in the same administrative database transaction, independently of node apps.
 * No cross-database user FK or application privilege is appropriate here.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const control = pgSchema("cogni_control");
export const databaseRecoveries = control.table(
  "database_recoveries",
  {
    nodeId: uuid("node_id").notNull(),
    nodeSlug: text("node_slug").notNull(),
    environment: text("environment").notNull(),
    incidentId: text("incident_id").notNull(),
    actorId: text("actor_id").notNull(),
    targetBuildSha: text("target_build_sha").notNull(),
    databaseSystemIdentifier: text("database_system_identifier").notNull(),
    databaseName: text("database_name").notNull(),
    appRole: text("app_role").notNull(),
    serviceRole: text("service_role").notNull(),
    state: text("state").notNull().default("contained"),
    isCurrent: boolean("is_current").notNull().default(true),
    reason: text("reason").notNull(),
    containedAt: timestamp("contained_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [table.nodeId, table.environment, table.incidentId],
    }),
    uniqueIndex("database_recoveries_current_node_env")
      .on(table.nodeId, table.environment)
      .where(sql`${table.isCurrent}`),
    uniqueIndex("database_recoveries_current_role_pair")
      .on(table.appRole, table.serviceRole)
      .where(sql`${table.isCurrent}`),
    index("database_recoveries_pending_deadline")
      .on(table.deadlineAt)
      .where(sql`${table.isCurrent} AND ${table.state} = 'recovering'`),
    check(
      "database_recoveries_environment",
      sql`${table.environment} IN ('candidate-a', 'preview', 'production')`
    ),
    check(
      "database_recoveries_state",
      sql`${table.state} IN ('contained', 'recovering', 'readmitted', 'recontained')`
    ),
    check(
      "database_recoveries_build_sha",
      sql`${table.targetBuildSha} ~ '^[0-9a-f]{40}$'`
    ),
    check(
      "database_recoveries_fixed_deadline",
      sql`(${table.startedAt} IS NULL AND ${table.deadlineAt} IS NULL) OR ${table.deadlineAt} = ${table.startedAt} + interval '10 minutes'`
    ),
    check(
      "database_recoveries_recovering_intent",
      sql`${table.state} <> 'recovering' OR (${table.startedAt} IS NOT NULL AND ${table.deadlineAt} IS NOT NULL)`
    ),
  ]
);
