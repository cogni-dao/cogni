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
 * - SCOPE_IS_THE_ACCOUNT (bug.5187): wallet_scope is `akash-console:<Akash account address>`,
 *   enforced by akash_tx_allocations_wallet_scope_account_check. It was `akash-console:<env>`
 *   until migration 0048, which made the index above INERT for the case it exists to catch —
 *   two writers on ONE account in two environments produced two scope strings and never
 *   collided. One account is now one slot, and a writer may serve many environments (the
 *   `environment` column, not the scope, records which one consumed the lease).
 * - RECEIPT_BEFORE_TRANSACTION: allocation_cursor is written before the Console POST; a row
 *   stuck in 'preparing' with a cursor means "a paid lease may exist" and must be resolved by
 *   recovery (cursor scan), never by a fresh create.
 * - KEY_IS_THE_IDEMPOTENCE_BOUNDARY: (wallet_scope, cogni_key) is unique AND is the key
 *   `claimOnce` looks a prior receipt up by. wallet_scope is therefore part of receipt
 *   IDENTITY, not merely a serializer input: changing the derived value without moving the
 *   rows in the same change hides every existing receipt, and a lookup that finds nothing
 *   mints a second paid lease beside one that is still billing (bug.5187).
 * - IDENTITY_IS_AUTHORITATIVE_NOT_INFERRED: node_id / environment / composite_uid /
 *   composite_generation are supplied EXPLICITLY by the caller on the wire and are NOT NULL
 *   here, so a spend receipt that cannot say which node consumed the infrastructure cannot
 *   physically exist. Identity is never parsed out of cogni_key, the workload slug, or the
 *   Console credential — a slug is renameable and a credential is custody, not consumption.
 * - IDENTITY_IS_WRITE_ONCE: node_id and composite_uid are written by the claiming INSERT and
 *   never appear in any UPDATE. composite_generation advances monotonically, because it
 *   records which composite revision was in front of the provider, not who owns the spend.
 * - IDENTICAL_SDL_IS_A_NO_OP (bug.5238): last_applied_sdl_hash records the sha256 of the SDL
 *   bytes last PUT for this receipt, so the actuator's update path can skip a re-PUT of the same
 *   SDL — an unconditional re-PUT re-triggers a provider redeploy and thrashes a node that has
 *   not yet reached a stable serving window. Advisory, not identity: it is written only by the
 *   update path and never gates a create.
 * - NODE_ID_IS_THE_COST_GROUPING_KEY: cost is attributed by this immutable UUID alone. It is
 *   NOT wallet_scope (which operator wallet serialized and paid), NOT a billing account, NOT
 *   a DAO address, and NOT a user or actor. Those five are distinct and must never substitute
 *   for one another; v0 is operator-sponsored, so only node_id is required.
 * - ONE_ACCOUNT_ONE_WRITER: wallet_scope is the serialization domain, so two processes spending
 *   from the SAME Console account MUST share a scope AND this database. Keying the scope on the
 *   account makes the first half automatic; the second half is why `account -> writer` stays
 *   injective while `writer -> envs` is deliberately one-to-many (a per-database index cannot
 *   see another database's ledger). The actuator enforces the converse at construction (see
 *   features/compute/akash-tx/akash-tx-wallet.ts) and the static half is asserted in
 *   tests/ci-invariants/crossplane-dormant-substrate.spec.ts.
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
/**
 * The shape every `wallet_scope` must have: `akash-console:` plus a bech32 Akash account address
 * (`akash1` + 38 data characters). ONE literal, in POSIX form so the database CHECK below and
 * every TypeScript consumer (the actuator's scope predicate, the boot gate's count query) are
 * the same predicate rather than two that must be kept in step by hand.
 *
 * It is also the discriminator between the account-keyed form and the legacy
 * `akash-console:<environment>` form bug.5187 replaced: no deploy environment is named `akash1…`.
 */
export const ACCOUNT_WALLET_SCOPE_PATTERN =
  "^akash-console:akash1[0-9a-z]{38}$";

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
    /**
     * sha256 hex of the exact Akash SDL bytes last PUT to the provider for this receipt
     * (bug.5238, IDENTICAL_SDL_IS_A_NO_OP). The in-place update path re-PUTs the SDL only when
     * the desired SDL hashes DIFFERENTLY from this value; a byte-identical re-PUT is skipped
     * because Console re-triggers a provider redeploy on every PUT, and re-deploying a
     * not-yet-serving node denies it the stable window it needs to start serving (the beacon /
     * node-template thrash). NULL until the first in-place update — the create path never writes
     * it, so the first update after a create always applies once and records the hash.
     */
    lastAppliedSdlHash: text("last_applied_sdl_hash"),
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
    /**
     * SCOPE_IS_PER_ACCOUNT_NEVER_PER_ENVIRONMENT (bug.5187). Every scope names a Console
     * ACCOUNT — `akash-console:` plus a bech32 Akash address — and no deploy environment is
     * named `akash1…`, so the legacy `akash-console:<environment>` form is UNWRITABLE once this
     * constraint exists. That is what makes the cutover safe against a writer still running the
     * old code: its claiming INSERT is rejected by the database and it spends nothing, instead
     * of silently opening a second serialization domain on the same account. Mirrors
     * `isAccountWalletScope` in features/compute/akash-tx/akash-tx-wallet.ts.
     */
    check(
      "akash_tx_allocations_wallet_scope_account_check",
      // The literal is inline because drizzle-kit serializes this expression into the snapshot:
      // interpolating the constant changes the serialized text and makes `db:check:generate-clean`
      // see permanent drift. `ACCOUNT_WALLET_SCOPE_PATTERN` is tied to it by assertion instead —
      // see akash-tx-wallet.test.ts, which reads this file and the committed 0048 migration.
      sql`${table.walletScope} ~ '^akash-console:akash1[0-9a-z]{38}$'`
    ),
  ]
);
