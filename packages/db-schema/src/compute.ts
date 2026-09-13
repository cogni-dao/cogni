// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/schema.compute`
 * Purpose: Compute provider outcome ledger backing the provider quality mandate (bid screening + blacklist) in the compute adapters (task.5051), plus the Akash wallet allocation ledger — the durable pre-transaction receipt that makes a lost Console response recoverable (task.5095).
 * Scope: Defines compute_provider_outcomes and akash_tx_allocations. Does not define
 *   workload/lease registry tables (vNext: compute_resources read-cache) or contain
 *   queries/blacklist/recovery logic.
 * Invariants:
 * - WALLET_SINGLE_WRITER: at most one akash_tx_allocations row per wallet_scope may sit in
 *   'preparing' (partial unique index). That window — pre-POST cursor written until the
 *   allocated handle is durable — is exactly when a lost response is unrecoverable, so it is
 *   serialized wallet-wide rather than per-workload.
 * - RECEIPT_BEFORE_TRANSACTION: allocation_cursor is written before the Console POST; a row
 *   stuck in 'preparing' with a cursor means "a paid lease may exist" and must be resolved by
 *   recovery (cursor scan), never by a fresh create.
 * - KEY_IS_THE_IDEMPOTENCE_BOUNDARY: (wallet_scope, cogni_key) is unique; a replayed create
 *   for a key that already reached 'allocated' returns the same external_name and spends nothing.
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
  uniqueIndex,
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

/**
 * Lifecycle of one wallet allocation attempt (source of truth for the DB CHECK).
 * `preparing` holds the wallet-wide slot; every other state has released it.
 */
export const AKASH_TX_ALLOCATION_STATES = [
  "preparing",
  "allocated",
  "released",
  "failed",
] as const;

/**
 * One durable receipt per Cogni idempotency key for the Akash Console transaction boundary.
 *
 * An Akash transaction can succeed while its HTTP response is lost. The only thing that makes
 * the resulting paid lease findable again is a baseline written BEFORE the POST: the cursor.
 * This table is that baseline, and it is deliberately independent of any Kubernetes object —
 * a deleted CR/XR must never be able to orphan the evidence (bug.5115 shape).
 */
export const akashTxAllocations = pgTable(
  "akash_tx_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Opaque one-writer scope — the Console wallet this row may spend from. */
    walletScope: text("wallet_scope").notNull(),
    /** Caller-supplied logical key; the whole idempotence contract hangs off it. */
    cogniKey: text("cogni_key").notNull(),
    /** Workload label (ProvisionSpec.name, e.g. the node slug). Observability only. */
    workload: text("workload").notNull(),
    /** Deployment environment the workload belongs to. Observability only. */
    environment: text("environment").notNull(),
    /** See AKASH_TX_ALLOCATION_STATES. */
    state: text("state").notNull(),
    /** Provider-opaque pre-POST high-water mark; the recovery scan's baseline. */
    allocationCursor: text("allocation_cursor"),
    /** Opaque provider handle (Akash dseq) once the allocation is durable. */
    externalName: text("external_name"),
    /** Provider account that won the lease, when known. */
    providerAccount: text("provider_account"),
    /** Stable redacted failure code; never provider response bodies. */
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When the wallet slot was released (allocated/released/failed). */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("akash_tx_allocations_key_idx").on(
      table.walletScope,
      table.cogniKey
    ),
    // WALLET_SINGLE_WRITER — enforced by the database, not by a lock an unlucky crash can drop.
    uniqueIndex("akash_tx_allocations_single_writer_idx")
      .on(table.walletScope)
      .where(sql`${table.state} = 'preparing'`),
    index("akash_tx_allocations_external_name_idx").on(table.externalName),
    check(
      "akash_tx_allocations_state_check",
      sql`${table.state} IN ('preparing', 'allocated', 'released', 'failed')`
    ),
  ]
);
