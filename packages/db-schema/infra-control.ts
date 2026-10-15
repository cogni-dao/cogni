// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/infra-control`
 * Purpose: Declare root-owned administrative incident state for atomic role containment and recovery intent.
 * Scope: Schema definitions only, outside the app schema glob and barrel; does not define node application tables or cross-database user references.
 * Invariants: Global role admission and durable intent share one administrative database transaction; current node and role bindings are unique.
 * Side-effects: none
 * Links: docs/spec/databases.md, infra/drizzle.control.config.ts
 * @internal
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const control = pgSchema("cogni_control");

/** Actual external manual readmission of an already genuine native incident; append-only to runtime roles. */
export const databaseCellReadmissionAudits = control.table(
  "database_cell_readmission_audits",
  {
    nodeId: uuid("node_id").notNull(),
    environment: text("environment").notNull(),
    incidentId: text("incident_id").notNull(),
    manualPacketSha256: text("manual_packet_sha256").notNull(),
    readmissionReceiptSha256: text("readmission_receipt_sha256").notNull(),
    expectedPreviousReceiptSha256: text(
      "expected_previous_receipt_sha256"
    ).notNull(),
    containedAt: timestamp("contained_at", { withTimezone: true }).notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    executionActor: jsonb("execution_actor").notNull(),
    approvalAuthority: jsonb("approval_authority").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.nodeId, table.environment, table.incidentId],
    }),
    uniqueIndex("database_cell_readmission_audits_receipt").on(
      table.readmissionReceiptSha256
    ),
    check(
      "database_cell_readmission_audits_environment",
      sql`${table.environment} IN ('candidate-a','preview','production')`
    ),
    check(
      "database_cell_readmission_audits_sha",
      sql`${table.manualPacketSha256} ~ '^[0-9a-f]{64}$' AND ${table.readmissionReceiptSha256} ~ '^[0-9a-f]{64}$' AND ${table.expectedPreviousReceiptSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "database_cell_readmission_audits_time",
      sql`${table.containedAt} <= ${table.admittedAt} AND ${table.admittedAt} <= ${table.importedAt}`
    ),
  ]
);

/** Historical manual admission imported without inventing a native incident. */
export const databaseCellAdmissions = control.table(
  "database_cell_admissions",
  {
    nodeId: uuid("node_id").notNull(),
    nodeSlug: text("node_slug").notNull(),
    environment: text("environment").notNull(),
    allocationReceiptId: uuid("allocation_receipt_id").notNull(),
    dseq: text("dseq").notNull(),
    providerAccount: text("provider_account").notNull(),
    databaseSystemIdentifier: text("database_system_identifier").notNull(),
    databaseName: text("database_name").notNull(),
    appRole: text("app_role").notNull(),
    serviceRole: text("service_role").notNull(),
    probeRole: text("probe_role").notNull(),
    targetBuildSha: text("target_build_sha").notNull(),
    manualPacketSha256: text("manual_packet_sha256").notNull(),
    readmissionReceiptSha256: text("readmission_receipt_sha256").notNull(),
    executionActor: jsonb("execution_actor").notNull(),
    approvalAuthority: jsonb("approval_authority").notNull(),
    preservedRoleBounds: jsonb("preserved_role_bounds").notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedControlSourceSha: text("reviewed_control_source_sha").notNull(),
    migrationManifestSha256: text("migration_manifest_sha256").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.environment] }),
    uniqueIndex("database_cell_admissions_owned_database").on(
      table.databaseName
    ),
    uniqueIndex("database_cell_admissions_owned_roles").on(
      table.appRole,
      table.serviceRole
    ),
    check(
      "database_cell_admissions_environment",
      sql`${table.environment} IN ('candidate-a', 'preview', 'production')`
    ),
    check(
      "database_cell_admissions_native_system",
      sql`${table.databaseSystemIdentifier} ~ '^[1-9][0-9]*$'`
    ),
    check(
      "database_cell_admissions_app_sha",
      sql`${table.targetBuildSha} ~ '^[0-9a-f]{40}$'`
    ),
    check(
      "database_cell_admissions_control_sha",
      sql`${table.reviewedControlSourceSha} ~ '^[0-9a-f]{40}$'`
    ),
    check(
      "database_cell_admissions_packet_sha",
      sql`${table.manualPacketSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "database_cell_admissions_receipt_sha",
      sql`${table.readmissionReceiptSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "database_cell_admissions_migration_sha",
      sql`${table.migrationManifestSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "database_cell_admissions_real_admission_time",
      sql`${table.admittedAt} <= ${table.importedAt} AND ${table.installedAt} <= ${table.importedAt}`
    ),
  ]
);

/** One fixed, bounded, read-only diagnostic child owned by an admitted node. */
export const databaseCellReplayRoles = control.table(
  "database_cell_replay_roles",
  {
    nodeId: uuid("node_id").notNull(),
    environment: text("environment").notNull(),
    databaseName: text("database_name").notNull(),
    roleName: text("role_name").notNull(),
    connectionLimit: integer("connection_limit").notNull(),
    workloadManifestSha256: text("workload_manifest_sha256").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.environment] }),
    uniqueIndex("database_cell_replay_roles_owned_database").on(
      table.databaseName
    ),
    uniqueIndex("database_cell_replay_roles_owned_role").on(table.roleName),
    check(
      "database_cell_replay_roles_environment",
      sql`${table.environment} IN ('candidate-a', 'preview', 'production')`
    ),
    check(
      "database_cell_replay_roles_bounded_connections",
      sql`${table.connectionLimit} = 8`
    ),
    check(
      "database_cell_replay_roles_workload_sha",
      sql`${table.workloadManifestSha256} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
export const databaseRecoveryWatchdogTicks = control.table(
  "database_recovery_watchdog_ticks",
  {
    environment: text("environment").primaryKey(),
    ownerId: text("owner_id").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    enforcedAt: timestamp("enforced_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "database_recovery_watchdog_environment",
      sql`${table.environment} IN ('candidate-a', 'preview', 'production')`
    ),
    check(
      "database_recovery_watchdog_protocol",
      sql`${table.protocolVersion} = 1`
    ),
  ]
);
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
