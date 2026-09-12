// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/db/compute-cost-intervals`
 * Purpose: Operator-local operational ledger allocating each paid compute resource to a node_id.
 * Scope: One mutable-monotonic interval per provider resource, grouped by infrastructure node_id.
 *   No invoices, fiat conversion, user charges, provider credentials, or DAO custody authority.
 * Invariants: PREPARE_BEFORE_PROVIDER_IO, NODE_ID_IS_SOLE_GROUPING_KEY,
 *   ONE_INTERVAL_PER_RESOURCE, PROVIDER_NATIVE_AMOUNTS, NOT_PAYMENT_TENANCY — this ledger
 *   does not identify a DAO, billing account, actor, sponsor, or economic payer.
 * Side-effects: none
 * Links: task.5071, knowledge hub `akash-cicd-pareto-scope`
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

interface NativeAmountJson {
  readonly amount: string;
  readonly denom: string;
}

interface ComputeCostResourceShapeJson {
  readonly services: readonly {
    readonly name: string;
    readonly cpuUnits: number;
    readonly memoryMi: number;
    readonly storageMi: number;
  }[];
}

export const COMPUTE_COST_INTERVAL_STATES = [
  "prepared",
  "allocated",
  "active",
  "closed",
] as const;

export const computeCostIntervals = pgTable(
  "compute_cost_intervals",
  {
    /** Controller idempotency key. A prepared receipt exists before provider create I/O. */
    attemptKey: text("attempt_key").primaryKey(),
    /** Canonical repo-spec/ComputeWorkload node_id; the rebuildable nodes projection is not authority. */
    nodeId: uuid("node_id").notNull(),
    environment: text("environment").notNull(),
    workloadUid: text("workload_uid").notNull(),
    workloadGeneration: integer("workload_generation").notNull(),
    sourceSha: text("source_sha").notNull(),
    resourceShape: jsonb("resource_shape")
      .$type<ComputeCostResourceShapeJson>()
      .notNull(),
    state: text("state").notNull().default("prepared"),

    // Provider-neutral, opaque external identity. All columns below remain NULL while prepared.
    computeProvider: text("compute_provider"),
    resourceId: text("resource_id"),
    computeProviderAccountId: text("compute_provider_account_id"),
    computeSupplierAccountId: text("compute_supplier_account_id"),
    rateAmount: text("rate_amount"),
    rateDenom: text("rate_denom"),
    rateUnit: text("rate_unit"),
    /** Provider-native height/meter position, deliberately stored as an exact integer string. */
    providerOpenedAtPosition: text("provider_opened_at_position"),
    providerClosedAtPosition: text("provider_closed_at_position"),
    escrowState: text("escrow_state"),
    providerSettledAtPosition: text("provider_settled_at_position"),
    escrowFunds: jsonb("escrow_funds")
      .$type<readonly NativeAmountJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    cumulativeTransferred: jsonb("cumulative_transferred")
      .$type<readonly NativeAmountJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    /** Controller wall-clock time that closure was durably recorded, even without final evidence. */
    closedRecordedAt: timestamp("closed_recorded_at", { withTimezone: true }),

    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("compute_cost_intervals_resource_key").on(
      table.computeProvider,
      table.resourceId
    ),
    index("compute_cost_intervals_node_state_idx").on(
      table.nodeId,
      table.state
    ),
    index("compute_cost_intervals_workload_idx").on(
      table.workloadUid,
      table.workloadGeneration
    ),
    check(
      "compute_cost_intervals_state_check",
      sql`${table.state} IN ('prepared','allocated','active','closed')`
    ),
    check(
      "compute_cost_intervals_generation_check",
      sql`${table.workloadGeneration} > 0`
    ),
    check(
      "compute_cost_intervals_binding_check",
      sql`(
        ${table.state} = 'prepared'
        AND ${table.computeProvider} IS NULL
        AND ${table.resourceId} IS NULL
        AND ${table.computeProviderAccountId} IS NULL
        AND ${table.computeSupplierAccountId} IS NULL
        AND ${table.rateAmount} IS NULL
        AND ${table.rateDenom} IS NULL
        AND ${table.rateUnit} IS NULL
        AND ${table.providerOpenedAtPosition} IS NULL
        AND ${table.providerClosedAtPosition} IS NULL
        AND ${table.escrowState} IS NULL
        AND ${table.providerSettledAtPosition} IS NULL
        AND ${table.firstObservedAt} IS NULL
        AND ${table.lastObservedAt} IS NULL
        AND ${table.closedRecordedAt} IS NULL
      ) OR (
        ${table.state} = 'allocated'
        AND ${table.computeProvider} IS NOT NULL
        AND ${table.resourceId} IS NOT NULL
        AND ${table.computeProviderAccountId} IS NULL
        AND ${table.computeSupplierAccountId} IS NULL
        AND ${table.rateAmount} IS NULL
        AND ${table.rateDenom} IS NULL
        AND ${table.rateUnit} IS NULL
        AND ${table.providerOpenedAtPosition} IS NULL
        AND ${table.providerClosedAtPosition} IS NULL
        AND ${table.escrowState} IS NULL
        AND ${table.providerSettledAtPosition} IS NULL
        AND ${table.firstObservedAt} IS NULL
        AND ${table.lastObservedAt} IS NULL
        AND ${table.closedRecordedAt} IS NULL
      ) OR (
        ${table.state} IN ('active','closed')
        AND ${table.computeProvider} IS NOT NULL
        AND ${table.resourceId} IS NOT NULL
        AND ${table.computeProviderAccountId} IS NOT NULL
        AND ${table.computeSupplierAccountId} IS NOT NULL
        AND ${table.rateAmount} IS NOT NULL
        AND ${table.rateDenom} IS NOT NULL
        AND ${table.rateUnit} IS NOT NULL
        AND ${table.firstObservedAt} IS NOT NULL
        AND ${table.lastObservedAt} IS NOT NULL
        AND (
          (${table.state} = 'active' AND ${table.providerClosedAtPosition} IS NULL AND ${table.closedRecordedAt} IS NULL)
          OR (${table.state} = 'closed' AND ${table.closedRecordedAt} IS NOT NULL)
        )
      ) OR (
        ${table.state} = 'closed'
        AND ${table.computeProvider} IS NOT NULL
        AND ${table.resourceId} IS NOT NULL
        AND ${table.computeProviderAccountId} IS NULL
        AND ${table.computeSupplierAccountId} IS NULL
        AND ${table.rateAmount} IS NULL
        AND ${table.rateDenom} IS NULL
        AND ${table.rateUnit} IS NULL
        AND ${table.providerOpenedAtPosition} IS NULL
        AND ${table.providerClosedAtPosition} IS NULL
        AND ${table.escrowState} IS NULL
        AND ${table.providerSettledAtPosition} IS NULL
        AND ${table.firstObservedAt} IS NULL
        AND ${table.lastObservedAt} IS NULL
        AND ${table.closedRecordedAt} IS NOT NULL
      )`
    ),
    check(
      "compute_cost_intervals_rate_amount_check",
      sql`${table.rateAmount} IS NULL OR ${table.rateAmount} ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$'`
    ),
    check(
      "compute_cost_intervals_provider_positions_check",
      sql`(${table.providerOpenedAtPosition} IS NULL OR ${table.providerOpenedAtPosition} ~ '^(0|[1-9][0-9]*)$')
        AND (${table.providerClosedAtPosition} IS NULL OR ${table.providerClosedAtPosition} ~ '^(0|[1-9][0-9]*)$')
        AND (${table.providerSettledAtPosition} IS NULL OR ${table.providerSettledAtPosition} ~ '^(0|[1-9][0-9]*)$')
        AND (${table.providerSettledAtPosition} IS NULL OR ${table.escrowState} IS NOT NULL)
        AND (${table.providerOpenedAtPosition} IS NULL OR ${table.providerClosedAtPosition} IS NULL OR ${table.providerClosedAtPosition}::numeric >= ${table.providerOpenedAtPosition}::numeric)`
    ),
  ]
);
