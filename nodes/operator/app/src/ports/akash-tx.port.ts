// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/akash-tx.port`
 * Purpose: The irreducible Akash transaction boundary as a typed logical contract —
 *   observe/create/update/delete plus the two seams it needs (a Console transaction client
 *   and a durable allocation ledger). This is the actuator's interface, NOT a controller:
 *   no watches, timers, finalizers, retry policy, or reconciliation live behind it (task.5095).
 * Scope: Interface + error-code definitions only. Generic reconciliation (retry, backoff,
 *   readiness gating, deletion policy, composition) belongs to Crossplane and is deliberately
 *   absent here.
 * Invariants:
 *   - KEY_IS_THE_IDEMPOTENCE_BOUNDARY: every mutation carries a caller-owned `cogniKey`;
 *     replaying a key never mints a second paid lease.
 *   - RECEIPT_BEFORE_TRANSACTION: the ledger's cursor is written before any Console POST, so a
 *     lost response is recoverable from durable evidence alone.
 *   - IDENTITY_BEFORE_TRANSACTION: every mutating call carries an explicit
 *     `AkashTxWorkloadIdentity`, and that identity is durable in the SAME receipt before the
 *     Console is contacted. Identity is never inferred from the key, the slug, or the wallet.
 *   - FAIL_CLOSED_BUT_RECOVERABLE: an allocation that cannot be resolved to exactly one LIVE
 *     lease is reported as ambiguous and never healed by a fresh create. An allocation PROVEN
 *     not to be billing is a different thing entirely: it settles itself, releases the wallet
 *     slot, and is retryable under the same key (`allocation_rolled_back`). bug.5192 is what
 *     happens when those two are the same state — fail-closed with no exit is an outage.
 *   - MIGRATION_IS_NOT_A_PAYMENT_PRECONDITION (task.5135): no mutating call carries a migration
 *     requirement, and no migration state can refuse one. Renting compute proves nothing about
 *     a database. The per-digest migration is a RELEASE step stated on `observe` — the unpaid,
 *     level-triggered tick — whose phase is REPORTED to the caller and never enforced here.
 *     What this buys: the paid path needs no database-adjacent capability at all, and a
 *     workload with a bad or missing schema fails READINESS (bounded by the composite's boot
 *     SLO) instead of silently never being created — the toks5 failure mode, where a valid XR
 *     with a valid digest never reached the actuator and never existed in any environment.
 *   - REFUSAL_IS_OBSERVABLE: every code here is a stable string safe for logs, Events and
 *     Crossplane conditions — a refusal a caller cannot see is a bug (bug.5115 shape).
 * Side-effects: none (types only)
 * Links: features/compute/akash-tx/akash-tx-actuator.ts,
 *   adapters/server/compute/akash-compute.adapter.ts, @shared/db/akash-tx-allocations,
 *   story.5016 R2.2, task.5095, task.5103
 * @public
 */

import type {
  ProvisionOutput,
  ProvisionSpec,
  ProvisionState,
} from "@cogni/ai-tools";

import type { ComputeWorkloadMigrationPort } from "./compute-workload-migration.port";

/**
 * WHICH NODE consumed the infrastructure, stated explicitly by the caller. Never derived.
 *
 * Identity is a first-class input rather than something the actuator parses, because every
 * derivable source is wrong: `cogniKey` is an idempotence token whose composition is the
 * caller's business, the workload slug is renameable, and the Console credential says who PAID
 * (custody), not who CONSUMED. These are five distinct facts and none may substitute for
 * another — `nodeId` (consumption, the cost-grouping key), `walletScope` (custody), and the
 * future `billingAccountId` / `daoAddress` / `actorId`, which v0 deliberately does not carry
 * because Cogni sponsors every node.
 */
export interface AkashTxWorkloadIdentity {
  /** Immutable repo-spec node UUID. The sole cost-grouping key. */
  readonly nodeId: string;
  /** `metadata.uid` of the composite requesting the mutation. Opaque; bound write-once. */
  readonly compositeUid: string;
  /** `metadata.generation` of that composite. Advances; it is a revision, not an owner. */
  readonly compositeGeneration: number;
}

/** Stable, redacted failure codes. Safe for HTTP bodies, logs, and XR conditions. */
export type AkashTxErrorCode =
  /** Another Cogni key holds the wallet-wide allocation slot; retry later. */
  | "wallet_allocation_blocked"
  /** A paid lease may exist for this key and could not be resolved. Never auto-create. */
  | "allocation_unresolved"
  /** More than one post-baseline allocation exists: deterministic adoption impossible. */
  | "allocation_ambiguous"
  /**
   * The previous attempt under this key opened a deployment that is now PROVEN closed, so its
   * receipt was settled and the wallet slot released. Nothing is billing and nothing was
   * double-paid. Retry with the SAME key — the next attempt re-claims a clean slot.
   */
  | "allocation_rolled_back"
  /** Provider IO failed in a way that leaves the outcome unknown (mutating call). */
  | "outcome_unknown"
  /** Provider refused the request terminally (screening, rejected SDL, bad handle). */
  | "provider_rejected"
  /** Provider unreachable / timed out on a non-mutating call. */
  | "provider_unavailable"
  /** The referenced external resource does not exist at the provider. */
  | "not_found"
  /** Durable ledger unavailable — the actuator must refuse to spend without a receipt. */
  | "ledger_unavailable"
  // `migration_pending` / `migration_failed` / `migration_unavailable` were REMOVED with
  // task.5135. They were the three ways a database could refuse to let a computer be rented.
  // Migration state is now an observation (`AkashTxObservation.migration.phase`), and an
  // observation is not a refusal — leaving dead codes here would leave the old contract
  // readable in the type that defines it.
  /** Caller sent a structurally invalid request. */
  | "invalid_request"
  /** Caller is not authorized to reach the actuator. */
  | "unauthorized"
  /**
   * The durable receipt for this key binds a DIFFERENT node/environment, or no receipt binds
   * it at all. Terminal for this desired state: retrying cannot change who paid for what, and
   * spending on under it would silently mis-attribute cost.
   */
  | "identity_conflict";

/** Every refusal the actuator can emit carries one of the codes above. */
export class AkashTxError extends Error {
  constructor(
    public readonly code: AkashTxErrorCode,
    message: string,
    /** Owning key when the refusal names another allocation (blocked). */
    public readonly ownerCogniKey?: string
  ) {
    super(message);
    this.name = "AkashTxError";
  }
}

/**
 * The RELEASE-side migration step the caller may attach to an `observe` (task.5135). Its
 * presence is the whole policy — a workload with a database sends it, one without omits it —
 * because the only decision left is "run it or don't", and presence already says that.
 *
 * There is no `Skip` member and no `policy` discriminator any more. Both existed to describe a
 * GATE, and there is no gate: this type can only cause a Job to be ensured and a phase to be
 * reported, never a transaction to be refused.
 *
 * Deliberately NOT on this wire: the migration COMMANDS. A caller-supplied command would let
 * anyone who can call the actuator run arbitrary containers against the environment's database
 * under the actuator's service account. The `profile` selects a command set the actuator owns.
 */
export interface AkashTxMigrationStep {
  /** Which migration contract to run; selects the actuator-owned phases. */
  readonly profile: "cogni-node-app-v1";
  /** `sha256:<64 hex>` from the workload's digest-pinned bundle ref. */
  readonly bundleDigest: string;
  /** Digest-pinned app artifact image — the same image the k3s initContainer runs. */
  readonly image: string;
  /** True when the app service declares a `DOLTGRES_URL` secret ref. */
  readonly doltgres: boolean;
}

/** Outcome of one bounded, non-throwing migration-step attempt. */
export type AkashTxMigrationPhase =
  | "succeeded"
  | "running"
  | "failed"
  /** No migration capability is wired, or the attempt could not be completed either way. */
  | "unavailable";

/**
 * The release-step seam. Structurally satisfied by `ComputeWorkloadMigrationPort`
 * (`KubernetesMigrationJobAdapter`), so the actuator and the frozen controller drive migration
 * currency with ONE implementation — including its `compute_workload_migration_job_infra_retry`
 * reclassification of a `DeadlineExceeded` Job with no failed migrate container.
 */
export type AkashTxMigrationPort = ComputeWorkloadMigrationPort;

/** Provider-opaque view of one Akash workload. `externalName` is the Crossplane handle. */
export interface AkashTxResource {
  readonly externalName: string;
  readonly state: ProvisionState;
  readonly endpoints: readonly string[];
  readonly providerAccount?: string;
}

/** Result of a logical observe. `found: false` means "safe to create". */
export interface AkashTxObservation {
  readonly found: boolean;
  readonly resource?: AkashTxResource;
  /**
   * Single bounded serving probe (exact source SHA + fixed `/readyz`) when the caller asked
   * for one. Undefined means "not probed". Convergence polling is the caller's job.
   */
  readonly serving?: boolean;
  /** True when the resource was adopted from a durable receipt after a lost response. */
  readonly recovered?: boolean;
  /**
   * Phase of the release-side migration step, when the caller attached one. Undefined means
   * "not asked". This is an OBSERVATION, not a verdict — nothing in this port refuses a
   * transaction because of it.
   */
  readonly migration?: { readonly phase: AkashTxMigrationPhase };
}

export interface AkashTxCreateResult extends AkashTxResource {
  /** True when an existing durable allocation satisfied the call and nothing was spent. */
  readonly replayed: boolean;
  /** True when the handle came from post-response-loss recovery rather than a new POST. */
  readonly recovered: boolean;
}

/**
 * The private, typed logical contract. Each method is ONE bounded attempt; the caller
 * (Crossplane) owns retry, backoff, and give-up policy.
 */
export interface AkashTxActuatorPort {
  observe(input: {
    cogniKey: string;
    externalName?: string;
    expectedSourceSha?: string;
    /** Public hostname; presence upgrades the serving proof to the host-routed path. */
    publicHost?: string;
    /** Attach the release-side migration step to this tick. Never blocks the observation. */
    migration?: AkashTxMigrationStep;
    /** Workload slug + environment, required only when `migration` is attached. */
    workload?: string;
    environment?: string;
  }): Promise<AkashTxObservation>;
  create(input: {
    cogniKey: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    spec: ProvisionSpec;
  }): Promise<AkashTxCreateResult>;
  update(input: {
    cogniKey: string;
    externalName: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    spec: ProvisionSpec;
  }): Promise<AkashTxResource>;
  delete(input: { cogniKey: string; externalName: string }): Promise<void>;
  /**
   * ONE bounded pass over receipts stuck mid-transaction, verifying each against Console
   * before settling it. Still no watches, no timers and no retry policy in here: this is a
   * single attempt the caller schedules, exactly like the other four operations.
   *
   * Exists because a crashed create cannot settle its own receipt (the crash IS the reason),
   * and the receipt it leaves behind holds a WALLET-WIDE slot: without a sweeper, one dead
   * process stops every node in the environment from leasing (bug.5192).
   */
  sweepStaleAllocations(input: {
    olderThanMs: number;
    limit: number;
  }): Promise<AkashTxSweepReport>;
  /**
   * Bounded, read-only enumeration of every LIVE lease's log coordinates plus ONE short-lived
   * logs-scoped provider token (bug.5240). This is the seam that makes "deployed via operator
   * ⇒ logs observable" structural: coverage derives from the allocation ledger — the same
   * durable receipt that proves the spend — so a lease that exists is a lease that can be
   * tailed, with zero per-node configuration. No wallet slot, no Console mutation, no ledger
   * write. Per-lease Console read failures skip that source (fail-open: observability must
   * never wedge on one sick lease); only a token-mint failure refuses the whole call.
   */
  leaseLogSources(input: {
    environment?: string;
    limit?: number;
  }): Promise<AkashTxLeaseLogSources>;
}

/** Per-pass counts for the sweeper's single structured log line. */
export interface AkashTxSweepReport {
  readonly scanned: number;
  /** Receipts settled because nothing is billing under them. */
  readonly rolledBack: number;
  /** Receipts whose lost allocation was found live and bound to the receipt instead. */
  readonly adopted: number;
  /** Receipts deliberately LEFT held: ambiguous wallet, or Console could not be read. */
  readonly held: number;
}

/**
 * What the wallet says about a possibly-lost allocation, beyond a pre-transaction baseline.
 * Structurally identical to (and satisfied by) the adapter's own `AkashAllocationProbe`; it is
 * restated here so the port owns its contract and `@/ports` never imports from `@/adapters`.
 */
export type AkashAllocationProbe =
  | { outcome: "adopted"; output: ProvisionOutput }
  | { outcome: "settled" }
  | { outcome: "ambiguous"; dseqs: readonly string[] };

/**
 * The Console transaction client the actuator needs. Structurally satisfied by
 * AkashComputeAdapter — SDL construction, provider screening, and bid/lease mechanics stay
 * inside that adapter and never cross this seam.
 */
export interface AkashTxConsolePort {
  /** Opaque pre-transaction high-water mark; the recovery scan's baseline. */
  allocationCursor(): Promise<string>;
  /** Create + screen + lease in one paid transaction. Returns when the lease exists. */
  allocateAndLease(input: {
    spec: ProvisionSpec;
    onAllocated?: (leaseId: string) => Promise<void>;
  }): Promise<{ leaseId: string; providerAccount: string }>;
  /**
   * Classify the wallet beyond a pre-transaction baseline into exactly one of three worlds:
   * `adopted` (one live allocation — it is ours), `settled` (no LIVE allocation beyond the
   * baseline: nothing is billing, whether or not a transaction ever landed), `ambiguous`
   * (several — undecidable, stay fail-closed).
   *
   * bug.5192: the old `ProvisionOutput | null` shape could not express `settled`, so every
   * crashed create became a permanent `allocation_unresolved` holding the wallet-wide slot.
   */
  findAllocationSince(cursor: string): Promise<AkashAllocationProbe>;
  status(input: { leaseId: string }): Promise<ProvisionOutput>;
  /**
   * sha256 hex of the exact SDL bytes `updateAllocated(spec)` would PUT for this spec — the same
   * `buildAkashSdl` render, pricing options and all. Pure and deterministic: identical spec →
   * identical hash. It lives on this port (not the actuator) so SDL construction and the pricing
   * options it needs stay inside the adapter and never cross the seam. The actuator compares it
   * to the receipt's `lastAppliedSdlHash` to no-op a byte-identical re-PUT (bug.5238).
   */
  sdlHash(spec: ProvisionSpec): string;
  /** In-place SDL replacement on a known handle. Returns once the provider accepted it. */
  updateAllocated(input: {
    resourceId: string;
    spec: ProvisionSpec;
  }): Promise<void>;
  release(input: { leaseId: string }): Promise<void>;
  /**
   * Read-only lease coordinates + declared service names for one paid handle (bug.5240).
   * Feeds `leaseLogSources`; never mutates and never mints. `services` comes from the lease's
   * own manifest status, so log coverage enumerates from the same record that deployed.
   */
  leaseLogDescriptor(input: {
    leaseId: string;
  }): Promise<AkashLeaseLogDescriptor>;
  /**
   * Wallet-signed, logs-scoped, short-TTL provider bearer (AEP-64 granular JWT). The ONLY
   * capability the token grants is reading lease logs on the named providers — it can never
   * spend, close, or mutate. Custody note: only the actuator can mint (it holds the Console
   * key); consumers receive the ephemeral token, never the credential.
   */
  mintLeaseLogsToken(input: {
    providers: readonly string[];
    ttlSeconds: number;
  }): Promise<string>;
}

/** Lease coordinates + service names for provider log reads. Read-only, provider-opaque. */
export interface AkashLeaseLogDescriptor {
  readonly gseq: number;
  readonly oseq: number;
  readonly providerAccount?: string;
  /** Provider gateway base URI (https host the lease-logs endpoint lives on). */
  readonly providerHostUri?: string;
  /** SDL service names reported by the lease manifest status. */
  readonly services: readonly string[];
  readonly state: ProvisionState;
}

/** One pollable provider log source — everything a keyless reader needs for one lease. */
export interface AkashTxLeaseLogSource {
  readonly nodeId: string;
  /** Workload slug (ProvisionSpec.name). Observability label, never identity. */
  readonly workload: string;
  readonly environment: string;
  readonly dseq: string;
  readonly gseq: number;
  readonly oseq: number;
  readonly providerAccount: string;
  readonly providerHostUri: string;
  readonly services: readonly string[];
}

/** Bounded snapshot of every live lease's log coordinates plus one shared ephemeral token. */
export interface AkashTxLeaseLogSources {
  readonly sources: readonly AkashTxLeaseLogSource[];
  /** Logs-scoped JWT covering every provider above. Empty when `sources` is empty. */
  readonly token: string;
  readonly ttlSeconds: number;
}

export type AkashTxAllocationState =
  | "preparing"
  | "allocated"
  | "released"
  | "failed";

export interface AkashTxAllocationRecord {
  /** Durable allocation receipt row. Cost intervals attach here, never to a mutable node row. */
  readonly receiptId: string;
  readonly cogniKey: string;
  /** The identity this receipt is bound to. NOT NULL in the table: it always exists. */
  readonly identity: AkashTxWorkloadIdentity;
  /** Workload label (ProvisionSpec.name, the node slug). Observability only, never identity. */
  readonly workload: string;
  readonly environment: string;
  readonly state: AkashTxAllocationState;
  readonly allocationCursor?: string;
  readonly externalName?: string;
  readonly providerAccount?: string;
  /**
   * sha256 hex of the SDL bytes last PUT to the provider for this receipt (bug.5238). Undefined
   * until the first in-place update; the create path never sets it. The update path no-ops a
   * re-PUT when the desired SDL hashes to this value.
   */
  readonly lastAppliedSdlHash?: string;
}

/** A receipt that has held the wallet slot longer than any single transaction can take. */
export interface AkashTxStaleAllocation {
  readonly cogniKey: string;
  /** Absent ⇒ durably PRE-transaction: the cursor is written before the POST, so no spend. */
  readonly allocationCursor?: string;
  /** Milliseconds this receipt has held the wallet slot, for the log line that reports it. */
  readonly heldForMs: number;
}

/**
 * Durable custody of "we may have paid". Deliberately independent of any Kubernetes object:
 * a deleted XR must never be able to orphan the evidence, and a slot must be resolvable by
 * whoever holds the key rather than only by the process that opened it.
 */
export interface AkashTxAllocationLedgerPort {
  /**
   * Take the wallet-wide slot for this key, or report the current holder.
   *
   * The INSERT that opens the slot is the receipt, and it carries the identity — so the
   * receipt binding node, environment, composite UID and generation to the key is durable
   * before the caller has even read an allocation cursor, let alone posted a transaction.
   *
   * A receipt already settled `failed` with NO handle is RE-CLAIMABLE and answers `claimed`
   * again (bug.5192). `failed AND external_name IS NULL` is only ever written with proof that
   * nothing is billing, so there is no spend to double-pay — while `allocated`/`released`
   * (which DID bind a handle) stay terminal `settled` exactly as before. Without this, the
   * only escape from a crashed create is a human editing `lease_epoch` in the catalog.
   */
  claim(input: {
    cogniKey: string;
    workload: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
  }): Promise<
    | { state: "claimed"; record: AkashTxAllocationRecord }
    | { state: "owned"; record: AkashTxAllocationRecord }
    | { state: "settled"; record: AkashTxAllocationRecord }
    | { state: "blocked"; ownerCogniKey: string }
  >;
  /**
   * Bind an EXISTING receipt to the identity of the mutation about to be sent, and advance the
   * observed composite generation monotonically. This is the non-create path onto the SAME
   * receipt row — an in-place SDL replacement mints no handle, but it still puts a new revision
   * in front of a paid resource, so it must be attributable before the provider is contacted.
   *
   * Reports rather than decides: `absent` (no receipt binds this key) and `conflict` (the
   * receipt belongs to another node or environment) are both refusals the ACTUATOR raises.
   */
  bindIdentity(input: {
    cogniKey: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
  }): Promise<
    | { state: "bound"; record: AkashTxAllocationRecord }
    | { state: "absent" }
    | { state: "conflict"; record: AkashTxAllocationRecord }
  >;
  /**
   * Persist the pre-POST baseline. MUST reject when the key does not own a `preparing` slot —
   * a resumed zombie with no slot must never proceed to spend.
   */
  prepare(input: { cogniKey: string; allocationCursor: string }): Promise<void>;
  /** Record the paid handle and release the wallet slot. Idempotent. */
  recordAllocation(input: {
    cogniKey: string;
    externalName: string;
    providerAccount?: string;
  }): Promise<void>;
  /**
   * Persist the sha256 of the SDL just PUT for this key, so the next in-place update can no-op a
   * byte-identical re-PUT (bug.5238). Called ONLY after `updateAllocated` succeeds — persisting
   * before the PUT would make a failed apply skip forever. Advisory metadata, never identity: it
   * does not touch the wallet slot, node_id, composite_uid, or the handle.
   */
  recordAppliedSdlHash(input: {
    cogniKey: string;
    sdlHash: string;
  }): Promise<void>;
  /**
   * Settle a receipt that never bound a paid resource, releasing the wallet-wide slot.
   *
   * Legal ONLY when nothing can still be billing under this key — i.e. the caller holds
   * positive evidence: the create never reached a transaction (no cursor), or the deployment
   * it opened was closed AND that closure was read back from Console. The implementation
   * enforces the half it can (`state='preparing' AND external_name IS NULL`, so a recorded
   * handle is never erased); the caller owns the closure proof.
   *
   * bug.5192: this method existed and was never called from production code, which is why one
   * crashed create held the account-wide writer slot for 33h.
   */
  fail(input: { cogniKey: string; failureCode: string }): Promise<void>;
  /**
   * Bounded scan for receipts stuck mid-transaction. Read-only, newest-last, hard-limited —
   * it decides nothing. The sweeper that consumes it must verify each row against Console
   * before settling anything (CLOSE_BEFORE_CLEAR); NO_TIME_BASED_RELEASE still holds, age is
   * only what makes a row ELIGIBLE to be investigated, never what settles it.
   */
  listStalePreparing(input: {
    olderThanMs: number;
    limit: number;
  }): Promise<readonly AkashTxStaleAllocation[]>;
  /** Mark a previously allocated key as released after a provider delete. */
  markReleased(input: { cogniKey: string }): Promise<void>;
  read(input: { cogniKey: string }): Promise<AkashTxAllocationRecord | null>;
  /**
   * Bounded enumeration of the wallet's LIVE paid leases: `state='allocated' AND
   * external_name IS NOT NULL` — receipts that bound a provider handle and have not been
   * released. Read-only, hard-limited, oldest-touched first — it decides nothing. This is the
   * money-loop's SEE primitive (story.5039): what the Argo prune → Crossplane REMOVE →
   * actuator delete chain is expected to close, enumerable BEFORE the close and provable
   * after (bug.5189: CLOSE→VERIFY→CLEAR; cluster state is never spend truth).
   *
   * `nodeId`/`environment` filters are OPTIONAL by design: the undetectable orphan is a lease
   * whose (node, env) the catalog NO LONGER declares, so the unfiltered walletScope-scoped
   * enumeration is the primitive — a query shaped "leases of the envs we know about" could
   * never see it.
   */
  listAllocated(input: {
    nodeId?: string;
    environment?: string;
    limit: number;
  }): Promise<readonly AkashTxAllocationRecord[]>;
  /**
   * Bounded enumeration of receipts in EVERY state for this wallet scope — the generation-
   * derivation primitive (task.5132). `requiredLeaseGeneration` must see terminal receipts
   * (`released`/`failed`): a terminal receipt permanently spends its generation for a re-added
   * env (the recreated composite carries a new UID, so `claim`'s failed-no-handle re-claim can
   * never match it — bug.5192's escape hatch does not apply across an XR recreation). The
   * `listAllocated` view above deliberately hides those states; deriving from it made an ADD
   * re-state a spent generation and the actuator refuse with `akash_tx_identity_conflict`.
   * Read-only, hard-limited, oldest-touched first — it decides nothing.
   */
  listReceipts(input: {
    nodeId?: string;
    environment?: string;
    limit: number;
  }): Promise<readonly AkashTxAllocationRecord[]>;
}
