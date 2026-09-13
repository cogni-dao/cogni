// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/akash-tx-allocations`
 * Purpose: Operator-local Drizzle schema for the Akash wallet allocation ledger — the durable
 *   pre-transaction receipt that makes a lost Akash Console response recoverable (task.5095).
 * Scope: Defines akash_tx_allocations only. Holds no queries, no recovery policy, and no
 *   provider IO — the adapter reads/writes it, the actuator decides.
 * Invariants:
 * - OPERATOR_LOCAL_NOT_SHARED: this table is operator operational Postgres. It is deliberately
 *   NOT in `@cogni/db-schema` — no other node owns an Akash Console wallet, and a shared-package
 *   table would make every fork's `db:generate` want to create it. Never Doltgres: these are
 *   system-of-record spend receipts, not AI-refined knowledge.
 * - WALLET_SINGLE_WRITER: at most one row per wallet_scope may sit in 'preparing' (partial
 *   unique index). That window — pre-POST cursor written until the allocated handle is durable —
 *   is exactly when a lost response is unrecoverable, so it is serialized wallet-wide rather
 *   than per-workload.
 * - RECEIPT_BEFORE_TRANSACTION: allocation_cursor is written before the Console POST; a row
 *   stuck in 'preparing' with a cursor means "a paid lease may exist" and must be resolved by
 *   recovery (cursor scan), never by a fresh create.
 * - KEY_IS_THE_IDEMPOTENCE_BOUNDARY: (wallet_scope, cogni_key) is unique; a replayed create for
 *   a key that already reached 'allocated' returns the same external_name and spends nothing.
 * - ONE_WALLET_ONE_WRITER: wallet_scope is the serialization domain, so two processes spending
 *   from the SAME Console wallet MUST share a scope AND this database. The actuator enforces the
 *   converse at construction (see features/compute/akash-tx/akash-tx-wallet.ts).
 * Side-effects: none
 * Links: adapters/server/compute/akash-tx-allocation-ledger.adapter.ts,
 *   features/compute/akash-tx/akash-tx-wallet.ts, docs/spec/databases.md, task.5095
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
