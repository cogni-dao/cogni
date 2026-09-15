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
 *   - FAIL_CLOSED: an allocation that cannot be resolved to exactly one lease is reported as
 *     unresolved/ambiguous and never healed by a fresh create.
 *   - MIGRATION_BEFORE_TRANSACTION: every mutating call carries an explicit migration
 *     requirement, and a `RequireBeforeTransaction` requirement that is not PROVEN complete is
 *     a refusal, never a pass (bug.5116 precondition, bug.5140 enforcement).
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
  /** The bundle digest's DB migration has not completed yet. Retry with the SAME key. */
  | "migration_pending"
  /** The bundle digest's DB migration ran and failed. Terminal until a new digest. */
  | "migration_failed"
  /** The migration precondition could not be PROVEN either way; never assume success. */
  | "migration_unavailable"
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
 * The migration precondition the CALLER states with every mutation (bug.5140, XRD
 * `spec.migration.policy`). Desired state names its own precondition; the actuator PROVES it
 * before it spends. Modelled as a discriminated union on purpose: there is no way to ask for
 * `RequireBeforeTransaction` without naming the digest that must be proven, so an
 * under-specified request is a schema error rather than a silently ungated paid lease.
 *
 * Deliberately NOT on this wire: the migration COMMANDS. A caller-supplied command would make
 * the gate advisory — anyone who can call the actuator could pass `true` and "prove" a
 * migration. The `profile` selects a command set the actuator owns.
 */
export type AkashTxMigrationRequirement =
  /** The workload has no database. The ONLY way to legitimately bypass the gate. */
  | { readonly policy: "Skip" }
  | {
      readonly policy: "RequireBeforeTransaction";
      /** Which migration contract must be proven; selects the actuator-owned phases. */
      readonly profile: "cogni-node-app-v1";
      /** `sha256:<64 hex>` from the workload's digest-pinned bundle ref. */
      readonly bundleDigest: string;
      /** Digest-pinned app artifact image — the same image the k3s initContainer runs. */
      readonly image: string;
      /** True when the app service declares a `DOLTGRES_URL` secret ref. */
      readonly doltgres: boolean;
    };

/**
 * The proof seam. Structurally satisfied by `ComputeWorkloadMigrationPort`
 * (`KubernetesMigrationJobAdapter`), so the actuator and the frozen controller prove migration
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
  }): Promise<AkashTxObservation>;
  create(input: {
    cogniKey: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    spec: ProvisionSpec;
    migration: AkashTxMigrationRequirement;
  }): Promise<AkashTxCreateResult>;
  update(input: {
    cogniKey: string;
    externalName: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    spec: ProvisionSpec;
    migration: AkashTxMigrationRequirement;
  }): Promise<AkashTxResource>;
  delete(input: { cogniKey: string; externalName: string }): Promise<void>;
}

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
  /** Adopt the unique post-baseline allocation, or null when none exists. */
  findAllocationSince(cursor: string): Promise<ProvisionOutput | null>;
  status(input: { leaseId: string }): Promise<ProvisionOutput>;
  /** In-place SDL replacement on a known handle. Returns once the provider accepted it. */
  updateAllocated(input: {
    resourceId: string;
    spec: ProvisionSpec;
  }): Promise<void>;
  release(input: { leaseId: string }): Promise<void>;
}

export type AkashTxAllocationState =
  | "preparing"
  | "allocated"
  | "released"
  | "failed";

export interface AkashTxAllocationRecord {
  readonly cogniKey: string;
  /** The identity this receipt is bound to. NOT NULL in the table: it always exists. */
  readonly identity: AkashTxWorkloadIdentity;
  readonly environment: string;
  readonly state: AkashTxAllocationState;
  readonly allocationCursor?: string;
  readonly externalName?: string;
  readonly providerAccount?: string;
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
  /** Terminal settle with NO resource. Legal only when no allocation can exist. */
  fail(input: { cogniKey: string; failureCode: string }): Promise<void>;
  /** Mark a previously allocated key as released after a provider delete. */
  markReleased(input: { cogniKey: string }): Promise<void>;
  read(input: { cogniKey: string }): Promise<AkashTxAllocationRecord | null>;
}
