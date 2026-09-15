// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/akash-tx-allocations`
 * Purpose: Operator-local Drizzle schema for the Akash wallet allocation ledger — the durable
 *   pre-transaction receipt that makes a lost Akash Console response recoverable (task.5095)
 *   AND authoritatively binds every paid mutation to the node that consumed it (task.5103).
 * Scope: Defines akash_tx_allocations only. Holds no queries, no recovery policy, and no
 *   provider IO — the adapter reads/writes it, the actuator decides. Cost FACTS (native rate,
 *   open/close positions, transferred amounts) are a separate interval table keyed by this
 *   receipt; this one owns identity and the single-writer slot.
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
 * - IDENTITY_IS_AUTHORITATIVE_NOT_INFERRED: node_id / environment / composite_uid /
 *   composite_generation are supplied EXPLICITLY by the caller on the wire and are NOT NULL
 *   here, so a spend receipt that cannot say which node consumed the infrastructure cannot
 *   physically exist. Identity is never parsed out of cogni_key, the workload slug, or the
 *   Console credential — a slug is renameable and a credential is custody, not consumption.
 * - IDENTITY_IS_WRITE_ONCE: node_id and composite_uid are written by the claiming INSERT and
 *   never appear in any UPDATE. composite_generation advances monotonically, because it
 *   records which composite revision was in front of the provider, not who owns the spend.
 * - NODE_ID_IS_THE_COST_GROUPING_KEY: cost is attributed by this immutable UUID alone. It is
 *   NOT wallet_scope (which operator wallet serialized and paid), NOT a billing account, NOT
 *   a DAO address, and NOT a user or actor. Those five are distinct and must never substitute
 *   for one another; v0 is operator-sponsored, so only node_id is required.
 * - ONE_WALLET_ONE_WRITER: wallet_scope is the serialization domain, so two processes spending
 *   from the SAME Console wallet MUST share a scope AND this database. The actuator enforces the
 *   converse at construction (see features/compute/akash-tx/akash-tx-wallet.ts).
 * Side-effects: none
 * Links: adapters/server/compute/akash-tx-allocation-ledger.adapter.ts,
 *   features/compute/akash-tx/akash-tx-wallet.ts, docs/spec/databases.md, task.5095,
 *   task.5103
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
    /**
     * WHICH NODE CONSUMED THE INFRASTRUCTURE. The immutable repo-spec node UUID, stated by the
     * caller on the wire (XComputeWorkload `spec.nodeId`, itself `format: uuid` + immutable).
     * This is the sole cost-grouping key. Deliberately NOT a foreign key to `nodes`: custody of
     * "we may have paid" must not depend on the registry's lifecycle, and purging a node row
     * must never be able to delete or block the evidence of what it spent.
     */
    nodeId: uuid("node_id").notNull(),
    /** Composite resource UID (`metadata.uid`) the mutation was requested for. Write-once. */
    compositeUid: text("composite_uid").notNull(),
    /** Composite `metadata.generation` of the latest mutation sent under this key. */
    compositeGeneration: integer("composite_generation").notNull(),
    /** Workload label (ProvisionSpec.name, e.g. the node slug). Observability only. */
    workload: text("workload").notNull(),
    /** Deployment environment. Authoritative: part of the cost-interval grouping with node_id. */
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
    // NODE_ID_IS_THE_COST_GROUPING_KEY — the access path every cost question takes.
    index("akash_tx_allocations_node_idx").on(table.nodeId, table.environment),
    check(
      "akash_tx_allocations_generation_check",
      sql`${table.compositeGeneration} > 0`
    ),
    check(
      "akash_tx_allocations_state_check",
      sql`${table.state} IN ('preparing', 'allocated', 'released', 'failed')`
    ),
  ]
);
