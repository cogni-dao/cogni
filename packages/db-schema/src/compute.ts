// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/schema.compute`
 * Purpose: Compute provider outcome ledger backing the provider quality mandate (bid screening + blacklist) in the compute adapters (task.5051).
 * Scope: Defines compute_provider_outcomes. Does not define workload/lease registry tables
 *   (vNext: compute_resources read-cache) or contain queries/blacklist logic.
 * Invariants:
 * - OUTCOMES_ARE_APPEND_ONLY: rows are facts about one boot attempt; blacklist state is DERIVED
 *   from history at read time (24h TTL per failure, permanent at 3 strikes), never stored.
 * - MANUAL_CLEAR_IS_ROW_DELETE: clearing a permanent blacklist = deleting the provider's
 *   failure rows (operator action); no status column to flip.
 * - No user FK — machine-plane operational data (RLS coverage gate does not apply; see
 *   attribution.ts precedent).
 * Side-effects: none (schema definitions only)
 * Links: adapters/server/compute/provider-outcome-store.ts (operator app),
 *   knowledge hub `akash-provider-quality-mandate`, task.5051
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Outcome of one workload boot attempt on a provider (source of truth for the DB CHECK). */
export const COMPUTE_PROVIDER_OUTCOMES = ["boot_ok", "slo_timeout"] as const;

/**
 * One row per workload boot attempt against one compute provider account.
 * Own pull-success history is the strongest predictor of workload success — marketplace
 * reputation measures the provider's status port, not registry egress.
 */
export const computeProviderOutcomes = pgTable(
  "compute_provider_outcomes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Compute marketplace label, e.g. "akash". Opaque — mirrors ComputeBalance.provider. */
    computeProvider: text("compute_provider").notNull(),
    /** Provider account on that marketplace (e.g. the akash1… owner address). */
    providerAccount: text("provider_account").notNull(),
    /** Boot attempt result; see COMPUTE_PROVIDER_OUTCOMES. */
    outcome: text("outcome").notNull(),
    /** Opaque workload handle (Akash dseq) of the attempt, when known. */
    leaseId: text("lease_id"),
    /** Workload label (ProvisionSpec.name, e.g. the node slug). */
    workload: text("workload"),
    /** Seconds from lease to first serving response (successes only). */
    bootSeconds: integer("boot_seconds"),
    /** Short human-readable context (never secrets / raw response bodies). */
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("compute_provider_outcomes_account_idx").on(
      table.computeProvider,
      table.providerAccount,
      table.createdAt
    ),
    check(
      "compute_provider_outcomes_outcome_check",
      sql`${table.outcome} IN ('boot_ok', 'slo_timeout')`
    ),
  ]
);
