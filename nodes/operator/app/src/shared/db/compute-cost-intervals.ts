// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Operator-local, provider-neutral cost intervals for paid compute resources.
 *
 * Every interval has a restrictive FK to the actuator allocation receipt that was durable
 * before provider IO. `node_id` remains authoritative on that receipt and is joined for
 * reporting; it is intentionally not copied or inferred here. No user, actor, scope, DAO,
 * payer, sponsor, wallet-owner, or billing-account identity belongs in this table.
 */
import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { akashTxAllocations } from "./akash-tx-allocations";

interface NativeAmountJson {
  readonly amount: string;
  readonly denom: string;
}

export const COMPUTE_COST_INTERVAL_STATES = [
  "allocated",
  "active",
  "closed",
] as const;

export const computeCostIntervals = pgTable(
  "compute_cost_intervals",
  {
    allocationReceiptId: uuid("allocation_receipt_id")
      .notNull()
      .primaryKey()
      .references(() => akashTxAllocations.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    state: text("state").notNull().default("allocated"),
    computeProvider: text("compute_provider").notNull(),
    resourceId: text("resource_id").notNull(),
    computeProviderAccountId: text("compute_provider_account_id"),
    computeSupplierAccountId: text("compute_supplier_account_id"),
    rateAmount: text("rate_amount"),
    rateDenom: text("rate_denom"),
    rateUnit: text("rate_unit"),
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
    closedRecordedAt: timestamp("closed_recorded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("compute_cost_intervals_resource_idx").on(
      table.computeProvider,
      table.resourceId
    ),
    check(
      "compute_cost_intervals_state_check",
      sql`${table.state} IN ('allocated','active','closed')`
    ),
    check(
      "compute_cost_intervals_evidence_check",
      sql`(
        ${table.state} = 'allocated'
        AND ${table.closedRecordedAt} IS NULL
        AND ${table.computeProviderAccountId} IS NULL
        AND ${table.computeSupplierAccountId} IS NULL
        AND ${table.rateAmount} IS NULL
        AND ${table.rateDenom} IS NULL
        AND ${table.rateUnit} IS NULL
        AND ${table.providerOpenedAtPosition} IS NULL
        AND ${table.providerClosedAtPosition} IS NULL
        AND ${table.escrowState} IS NULL
        AND ${table.providerSettledAtPosition} IS NULL
        AND ${table.escrowFunds} = '[]'::jsonb
        AND ${table.cumulativeTransferred} = '[]'::jsonb
        AND ${table.firstObservedAt} IS NULL
        AND ${table.lastObservedAt} IS NULL
      ) OR (
        ${table.state} = 'active'
        AND ${table.providerClosedAtPosition} IS NULL
        AND ${table.closedRecordedAt} IS NULL
        AND ${table.computeProviderAccountId} IS NOT NULL
        AND ${table.computeSupplierAccountId} IS NOT NULL
        AND ${table.rateAmount} IS NOT NULL
        AND ${table.rateDenom} IS NOT NULL
        AND ${table.rateUnit} IS NOT NULL
        AND ${table.escrowState} IS NOT NULL
        AND ${table.firstObservedAt} IS NOT NULL
        AND ${table.lastObservedAt} IS NOT NULL
      ) OR (
        ${table.state} = 'closed'
        AND ${table.closedRecordedAt} IS NOT NULL
        AND (
          (
            ${table.computeProviderAccountId} IS NULL
            AND ${table.computeSupplierAccountId} IS NULL
            AND ${table.rateAmount} IS NULL
            AND ${table.rateDenom} IS NULL
            AND ${table.rateUnit} IS NULL
            AND ${table.providerOpenedAtPosition} IS NULL
            AND ${table.providerClosedAtPosition} IS NULL
            AND ${table.escrowState} IS NULL
            AND ${table.providerSettledAtPosition} IS NULL
            AND ${table.escrowFunds} = '[]'::jsonb
            AND ${table.cumulativeTransferred} = '[]'::jsonb
            AND ${table.firstObservedAt} IS NULL
            AND ${table.lastObservedAt} IS NULL
          ) OR (
            ${table.computeProviderAccountId} IS NOT NULL
            AND ${table.computeSupplierAccountId} IS NOT NULL
            AND ${table.rateAmount} IS NOT NULL
            AND ${table.rateDenom} IS NOT NULL
            AND ${table.rateUnit} IS NOT NULL
            AND ${table.escrowState} IS NOT NULL
            AND ${table.firstObservedAt} IS NOT NULL
            AND ${table.lastObservedAt} IS NOT NULL
          )
        )
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
        AND (${table.providerOpenedAtPosition} IS NULL OR ${table.providerClosedAtPosition} IS NULL OR ${table.providerClosedAtPosition}::numeric >= ${table.providerOpenedAtPosition}::numeric)`
    ),
  ]
);
