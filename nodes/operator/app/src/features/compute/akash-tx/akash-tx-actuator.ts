// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-actuator`
 * Purpose: The Akash transaction actuator — the irreducible, Cogni-specific boundary where a
 *   logical workload becomes a PAID Akash lease. Owns wallet-global serialization, the durable
 *   pre-transaction receipt, post-response-loss recovery, and the typed workload contract.
 *   Extracted from the ComputeWorkload controller so Crossplane can own everything generic
 *   (task.5095, story.5016 R2.2).
 * Scope: Four bounded logical operations (observe/create/update/delete) over one Console
 *   client + one durable ledger. Does NOT watch, poll to convergence, retry, back off, hold
 *   finalizers, elect a leader, or reconcile — every one of those is Crossplane's job and
 *   their absence here is the point.
 * Invariants:
 *   - ONE_ATTEMPT_PER_CALL: each method performs at most one provider transaction. A caller
 *     that wants a second attempt makes a second call.
 *   - RECEIPT_BEFORE_TRANSACTION: the pre-POST cursor is durable before any Console POST, so a
 *     lost response leaves recoverable evidence rather than an orphan paid lease.
 *   - IDENTITY_BEFORE_TRANSACTION: the SAME receipt binds {nodeId, environment, composite
 *     uid/generation, cogniKey}, and it is bound by the claiming INSERT — before the allocation
 *     cursor is even read, let alone posted. Identity arrives EXPLICITLY on the wire from the
 *     Composition; this actuator never parses it out of the key, the slug, or the credential
 *     (task.5103). A key whose receipt binds a different node is refused, never re-bound:
 *     mis-attributed spend is unrecoverable in a way a retry is not.
 *   - WALLET_SINGLE_WRITER: the ledger slot is held for exactly the unrecoverable window
 *     (cursor read → allocated handle durable) and is wallet-wide, never per-workload. The
 *     local writer is the environment's sole actuator; its legacy controller is absent and
 *     Console/manual writes are forbidden. Centralized v0 pins the managed test account on
 *     candidate-a ONLY (preview pins no wallet — one active writer per test wallet), while
 *     production remains isolated on a dedicated account (ci-cd.md Axiom 26).
 *   - FAIL_CLOSED: an allocation that cannot be resolved to exactly one lease raises
 *     allocation_unresolved / allocation_ambiguous. It is NEVER healed by a fresh create.
 *   - MIGRATION_IS_NOT_A_PAYMENT_PRECONDITION: NO mutating call states, proves, or can be
 *     refused by a migration. bug.5140 made a completed per-digest DB migration a precondition
 *     of every paid transaction; task.5135 severed that. Node toks5 is the proof it was wrong:
 *     a valid XR in `cogni-production` with a valid image digest whose migration never ran, so
 *     this actuator was NEVER CALLED, `akash-lease` reported "not yet ready" 1044 times, and
 *     the node never existed in any environment — silent, unbounded, no alarm. The migration is
 *     now a RELEASE step attached to `observe` (unpaid, no wallet slot, no Console POST), and
 *     its phase is REPORTED on the observation. A workload whose schema is bad or missing
 *     therefore gets its lease and fails READINESS against the composite's boot SLO — loud and
 *     bounded — which is what bug.5116 actually needed. The paid path consequently needs no
 *     database-adjacent capability at all.
 *   - REFUSAL_IS_OBSERVABLE: every refusal emits a structured log line before it throws
 *     (bug.5115: a wallet block that only reached CR status was invisible for hours).
 * Side-effects: IO (Akash Console transactions via the injected client; durable allocation and
 *   receipt-linked cost writes; one bounded serving probe per observe when asked)
 * Links: @ports/akash-tx.port, adapters/server/compute/akash-compute.adapter (SDL + provider
 *   screening stay there), adapters/server/compute/akash-tx-allocation-ledger.adapter,
 *   ./akash-tx-wallet, ./akash-tx-http, task.5095
 * @internal
 */

import type { ProvisionOutput, ProvisionSpec } from "@cogni/ai-tools";

import {
  type AkashTxActuatorPort,
  type AkashTxAllocationLedgerPort,
  type AkashTxAllocationRecord,
  type AkashTxConsolePort,
  type AkashTxCreateResult,
  AkashTxError,
  type AkashTxErrorCode,
  type AkashTxMigrationPhase,
  type AkashTxMigrationPort,
  type AkashTxMigrationStep,
  type AkashTxObservation,
  type AkashTxResource,
  type AkashTxWorkloadIdentity,
  type ComputeCostEvidencePort,
  type ComputeCostStorePort,
} from "@/ports";

import { runMigrationStep } from "./akash-tx-migration-step";

/** Structural pino subset. Fields first, stable marker second. */
export interface AkashTxLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Single bounded serving proof (exact source SHA + fixed `/readyz`). Never loops. */
export type AkashTxServingProbe = (input: {
  endpoints: readonly string[];
  expectedSourceSha: string;
}) => Promise<boolean>;

export interface AkashTxActuatorDeps {
  readonly console: AkashTxConsolePort;
  readonly ledger: AkashTxAllocationLedgerPort;
  readonly log: AkashTxLogger;
  /** Omitted → observe never reports `serving` and never touches the workload's ingress. */
  readonly probe?: AkashTxServingProbe;
  /**
   * The per-digest migration runner for the RELEASE step on `observe`. Omitted → an observe
   * that asks for a migration reports `phase: "unavailable"`. It does NOT refuse anything:
   * this seam can no longer stop a lease from being created (task.5135).
   */
  readonly migration?: AkashTxMigrationPort;
  /** Paired, receipt-linked cost seams. Production wiring supplies both or startup fails. */
  readonly costEvidence: ComputeCostEvidencePort;
  readonly costStore: ComputeCostStorePort;
  /** Pinned raw Akash deployment/escrow owner; not a Cogni user/DAO/payer identity. */
  readonly providerConsumerAccountId: string;
}

const NOOP_LOGGER: AkashTxLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Translate a provider client failure into a stable actuator code WITHOUT importing the
 * adapter (features must not reach into adapters/server). AkashComputeError carries
 * `name` + `code`, both of which are part of its published contract.
 */
export function mapConsoleFailure(
  error: unknown,
  opts: { mutating: boolean }
): AkashTxError {
  if (error instanceof AkashTxError) return error;
  const named = error as {
    name?: unknown;
    code?: unknown;
    httpStatus?: unknown;
  };
  const message = error instanceof Error ? error.message : "provider failure";
  if (named?.name === "AkashComputeError") {
    const code = String(named.code);
    if (code === "HTTP_ERROR" && named.httpStatus === 404) {
      return new AkashTxError("not_found", message);
    }
    if (code === "AMBIGUOUS_ADOPTION") {
      return new AkashTxError("allocation_ambiguous", message);
    }
    if (code === "TIMEOUT" || code === "NETWORK_ERROR") {
      return new AkashTxError(
        opts.mutating ? "outcome_unknown" : "provider_unavailable",
        message
      );
    }
    if (code === "NO_BIDS" || code === "NO_ELIGIBLE_BIDS") {
      return new AkashTxError("provider_rejected", message);
    }
    return new AkashTxError(
      opts.mutating ? "outcome_unknown" : "provider_rejected",
      message
    );
  }
  return new AkashTxError(
    opts.mutating ? "outcome_unknown" : "provider_unavailable",
    message
  );
}

/** Flat, stable log fields for a receipt binding. Every identity log line uses exactly these. */
function identityFields(
  identity: AkashTxWorkloadIdentity,
  environment: string
): Record<string, unknown> {
  return {
    nodeId: identity.nodeId,
    environment,
    compositeUid: identity.compositeUid,
    compositeGeneration: identity.compositeGeneration,
  };
}

/** True when a receipt already binds a DIFFERENT consumer than the one now asking to spend. */
function identityDiffers(
  record: AkashTxAllocationRecord,
  identity: AkashTxWorkloadIdentity,
  environment: string
): boolean {
  return (
    record.identity.nodeId !== identity.nodeId ||
    record.environment !== environment ||
    record.identity.compositeUid !== identity.compositeUid
  );
}

function resourceFrom(
  output: ProvisionOutput,
  providerAccount?: string
): AkashTxResource {
  return {
    externalName: output.leaseId,
    state: output.state,
    endpoints: [...output.endpoints],
    ...(providerAccount ? { providerAccount } : {}),
  };
}

/** Stable, non-secret classification for arbitrary provider/store failures. */
function costFailureType(error: unknown): string {
  const name = (error as { name?: unknown })?.name;
  if (name === "ComputeCostInvariantError") return "cost_invariant";
  if (name === "AkashComputeError") return "provider_evidence_error";
  if (error instanceof AkashTxError) return "actuator_cost_unavailable";
  return error instanceof Error ? "cost_dependency_error" : "unknown";
}

/**
 * The actuator. Construct one per process; it holds no timers, no queues, and no state
 * beyond its injected seams.
 */
export class AkashTxActuator implements AkashTxActuatorPort {
  private readonly console: AkashTxConsolePort;
  private readonly ledger: AkashTxAllocationLedgerPort;
  private readonly log: AkashTxLogger;
  private readonly probe?: AkashTxServingProbe;
  private readonly migration?: AkashTxMigrationPort;
  private readonly costEvidence: ComputeCostEvidencePort;
  private readonly costStore: ComputeCostStorePort;
  private readonly providerConsumerAccountId: string;

  constructor(deps: AkashTxActuatorDeps) {
    this.console = deps.console;
    this.ledger = deps.ledger;
    this.log = deps.log ?? NOOP_LOGGER;
    if (deps.probe) this.probe = deps.probe;
    if (deps.migration) this.migration = deps.migration;
    this.costEvidence = deps.costEvidence;
    this.costStore = deps.costStore;
    this.providerConsumerAccountId = deps.providerConsumerAccountId;
  }

  async observe(input: {
    cogniKey: string;
    externalName?: string;
    expectedSourceSha?: string;
    migration?: AkashTxMigrationStep;
    workload?: string;
    environment?: string;
  }): Promise<AkashTxObservation> {
    // The RELEASE step. It runs FIRST so the Job is ensured on the very first tick — before
    // there is any lease to observe — and its answer is carried onto whatever the observation
    // turns out to be. It never throws and never short-circuits: an observe that reported
    // "found: false" must keep reporting it, because that is the signal Crossplane uses to
    // create the lease, and a database has no business vetoing that (task.5135).
    const migration = await this.releaseMigration(input);
    const withMigration = (
      observation: AkashTxObservation
    ): AkashTxObservation =>
      migration
        ? { ...observation, migration: { phase: migration } }
        : observation;

    if (input.externalName) {
      const record = await this.requireStoredHandle(
        input.cogniKey,
        input.externalName,
        "observe"
      );
      const resource = await this.describe(
        input.externalName,
        record.providerAccount,
        record
      );
      return withMigration(
        await this.withServing(
          { found: true, resource },
          input.expectedSourceSha
        )
      );
    }
    const record = await this.readLedger(input.cogniKey);
    if (!record) return withMigration({ found: false });
    if (record.externalName) {
      const resource = await this.describe(
        record.externalName,
        record.providerAccount,
        record
      );
      return withMigration(
        await this.withServing(
          { found: true, resource },
          input.expectedSourceSha
        )
      );
    }
    if (record.state === "preparing" && record.allocationCursor) {
      // A durable receipt with no handle: the Console POST may have been paid for and its
      // response lost. Resolving it is the whole reason this service exists.
      const resource = await this.resolveUncertain(
        input.cogniKey,
        record.allocationCursor
      );
      return withMigration(
        await this.withServing(
          { found: true, resource, recovered: true },
          input.expectedSourceSha
        )
      );
    }
    // preparing with no cursor: the cursor is durable BEFORE the POST, so its absence
    // proves no transaction was started. Safe to create.
    return withMigration({ found: false });
  }

  async create(input: {
    cogniKey: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    spec: ProvisionSpec;
  }): Promise<AkashTxCreateResult> {
    // The claim IS the receipt, and it is the FIRST thing this method does: its INSERT carries
    // {nodeId, environment, compositeUid, compositeGeneration, cogniKey}. Everything below this
    // line — the cursor read and the paid POST — happens strictly after that row is durable.
    // Nothing precedes it any more; the migration gate that used to sit here was severed by
    // task.5135, and RECEIPT_BEFORE_TRANSACTION is stronger for it.
    const claim = await this.claim(input);

    if (claim.state === "blocked") {
      // bug.5115: this refusal used to exist only in CR status, which made a fleet-wide
      // wallet deadlock invisible. It is a log line first, a response second.
      this.log.warn(
        {
          cogniKey: input.cogniKey,
          ownerCogniKey: claim.ownerCogniKey,
          environment: input.environment,
          workload: input.spec.name,
        },
        "akash_tx_wallet_allocation_blocked"
      );
      throw new AkashTxError(
        "wallet_allocation_blocked",
        "another allocation holds the wallet slot",
        claim.ownerCogniKey
      );
    }

    if (claim.state !== "claimed") {
      // A receipt is custody of WHO consumed. Re-pointing one at another node would make the
      // cost grouping a lie, so a mismatch is terminal rather than something to heal.
      if (identityDiffers(claim.record, input.identity, input.environment)) {
        throw this.identityConflict({
          cogniKey: input.cogniKey,
          operation: "create",
          identity: input.identity,
          environment: input.environment,
          record: claim.record,
        });
      }
    } else {
      this.log.info(
        {
          cogniKey: input.cogniKey,
          workload: input.spec.name,
          ...identityFields(input.identity, input.environment),
        },
        "akash_tx_receipt_bound"
      );
    }

    if (claim.state === "settled") {
      if (claim.record.externalName) {
        this.log.info(
          {
            cogniKey: input.cogniKey,
            externalName: claim.record.externalName,
          },
          "akash_tx_create_replayed"
        );
        const resource = await this.describe(
          claim.record.externalName,
          claim.record.providerAccount,
          claim.record
        );
        return { ...resource, replayed: true, recovered: false };
      }
      // Terminally settled with no resource. Re-spending under a key that already has a
      // verdict is exactly the double-pay this service exists to prevent.
      this.log.warn(
        { cogniKey: input.cogniKey, ledgerState: claim.record.state },
        "akash_tx_create_refused_settled_key"
      );
      throw new AkashTxError(
        "provider_rejected",
        "cogniKey already settled without an allocation; a replacement needs a new key"
      );
    }

    if (claim.record.allocationCursor) {
      const resource = await this.resolveUncertain(
        input.cogniKey,
        claim.record.allocationCursor
      );
      return { ...resource, replayed: false, recovered: true };
    }

    const cursor = await this.readCursor();
    await this.prepare(input.cogniKey, cursor);
    this.log.info(
      {
        cogniKey: input.cogniKey,
        environment: input.environment,
        workload: input.spec.name,
        allocationCursor: cursor,
      },
      "akash_tx_allocation_prepared"
    );

    let allocated: { leaseId: string; providerAccount: string };
    try {
      allocated = await this.console.allocateAndLease({
        spec: input.spec,
        // Durability of the handle is a precondition of every later step: the client closes
        // the deployment if this throws, because an unrecorded dseq is a lease nobody can find.
        onAllocated: async (leaseId) => {
          await this.ledger.recordAllocation({
            cogniKey: input.cogniKey,
            externalName: leaseId,
          });
          this.log.info(
            { cogniKey: input.cogniKey, externalName: leaseId },
            "akash_tx_allocation_recorded"
          );
        },
      });
    } catch (error) {
      const mapped = mapConsoleFailure(error, { mutating: true });
      this.log.error(
        {
          cogniKey: input.cogniKey,
          environment: input.environment,
          workload: input.spec.name,
          allocationCursor: cursor,
          code: mapped.code,
          causeMessage: mapped.message,
        },
        mapped.code === "outcome_unknown"
          ? "akash_tx_allocation_outcome_unknown"
          : "akash_tx_allocation_failed"
      );
      throw mapped;
    }

    await this.ledger.recordAllocation({
      cogniKey: input.cogniKey,
      externalName: allocated.leaseId,
      providerAccount: allocated.providerAccount,
    });
    const allocationRecord = await this.requireStoredHandle(
      input.cogniKey,
      allocated.leaseId,
      "create"
    );
    await this.bindCost(allocationRecord, allocated.leaseId);
    const resource = await this.describe(
      allocated.leaseId,
      allocated.providerAccount,
      allocationRecord
    );
    this.log.info(
      {
        cogniKey: input.cogniKey,
        externalName: allocated.leaseId,
        providerAccount: allocated.providerAccount,
        state: resource.state,
      },
      "akash_tx_leased"
    );
    return { ...resource, replayed: false, recovered: false };
  }

  async update(input: {
    cogniKey: string;
    externalName: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    spec: ProvisionSpec;
  }): Promise<AkashTxResource> {
    // An update mints no handle and opens no escrow, so it needs no wallet slot — but it does
    // put a new revision in front of a resource that is already burning money, so it must be
    // attributable BEFORE the provider is contacted. This writes the advancing generation onto
    // the SAME receipt row the create opened; there is no second ledger and no second table.
    const bound = await this.bindIdentity(input);
    if (bound.state !== "bound") {
      throw this.identityConflict({
        cogniKey: input.cogniKey,
        operation: "update",
        identity: input.identity,
        environment: input.environment,
        ...(bound.state === "conflict" ? { record: bound.record } : {}),
      });
    }
    if (bound.record.externalName !== input.externalName) {
      throw this.identityConflict({
        cogniKey: input.cogniKey,
        operation: "update",
        identity: input.identity,
        environment: input.environment,
        record: bound.record,
      });
    }
    // Refresh durable native evidence before replacing a paid workload. A failed cost read/write
    // holds the update retryably and must leave the provider untouched.
    await this.observeCost(bound.record, input.externalName);
    this.log.info(
      {
        cogniKey: input.cogniKey,
        externalName: input.externalName,
        ...identityFields(input.identity, input.environment),
      },
      "akash_tx_receipt_rebound"
    );

    // PUT on a handle we already own is idempotent by construction.
    try {
      await this.console.updateAllocated({
        resourceId: input.externalName,
        spec: input.spec,
      });
    } catch (error) {
      const mapped = mapConsoleFailure(error, { mutating: true });
      this.log.error(
        {
          cogniKey: input.cogniKey,
          externalName: input.externalName,
          code: mapped.code,
          causeMessage: mapped.message,
        },
        "akash_tx_update_failed"
      );
      throw mapped;
    }
    this.log.info(
      { cogniKey: input.cogniKey, externalName: input.externalName },
      "akash_tx_updated"
    );
    return this.describe(
      input.externalName,
      bound.record.providerAccount,
      bound.record
    );
  }

  async delete(input: {
    cogniKey: string;
    externalName: string;
  }): Promise<void> {
    const record = await this.requireStoredHandle(
      input.cogniKey,
      input.externalName,
      "delete"
    );
    await this.observeCost(record, input.externalName).catch(
      (error: unknown) => {
        this.log.warn(
          {
            cogniKey: input.cogniKey,
            externalName: input.externalName,
            causeType: costFailureType(error),
          },
          "compute_cost_preclose_observation_failed"
        );
      }
    );
    try {
      await this.console.release({ leaseId: input.externalName });
    } catch (error) {
      const mapped = mapConsoleFailure(error, { mutating: true });
      if (mapped.code !== "not_found") {
        this.log.error(
          {
            cogniKey: input.cogniKey,
            externalName: input.externalName,
            code: mapped.code,
          },
          "akash_tx_delete_failed"
        );
        throw mapped;
      }
    }
    await this.ledger.markReleased({ cogniKey: input.cogniKey });
    await this.observeCost(record, input.externalName).catch(
      (error: unknown) => {
        this.log.warn(
          {
            cogniKey: input.cogniKey,
            externalName: input.externalName,
            causeType: costFailureType(error),
          },
          "compute_cost_final_observation_failed"
        );
      }
    );
    await this.closeCost(record);
    this.log.info(
      { cogniKey: input.cogniKey, externalName: input.externalName },
      "akash_tx_released"
    );
  }

  /**
   * One bounded, NON-THROWING release-migration attempt. Returns `undefined` when the caller
   * attached no step (or could not name the workload it belongs to), which is reported as
   * "not asked" rather than as a pass.
   *
   * It cannot throw by construction, and that is the point: this runs inside `observe`, the
   * call whose answer decides whether Crossplane creates the lease. An exception here would
   * re-create exactly the coupling task.5135 deleted.
   */
  private async releaseMigration(input: {
    cogniKey: string;
    migration?: AkashTxMigrationStep;
    workload?: string;
    environment?: string;
  }): Promise<AkashTxMigrationPhase | undefined> {
    if (!input.migration) return undefined;
    if (!input.workload || !input.environment) {
      // The step names a digest but not the workload whose database it belongs to. Refusing
      // to GUESS is the ENVIRONMENT_IS_THE_WORKLOAD'S invariant: migrating the wrong
      // environment's database is worse than not migrating.
      this.log.error(
        {
          cogniKey: input.cogniKey,
          bundleDigest: input.migration.bundleDigest,
        },
        "akash_tx_migration_target_unstated"
      );
      return "unavailable";
    }
    return runMigrationStep(
      {
        log: this.log,
        ...(this.migration ? { migration: this.migration } : {}),
      },
      {
        step: input.migration,
        cogniKey: input.cogniKey,
        environment: input.environment,
        workload: input.workload,
      }
    );
  }

  /**
   * Resolve "we may have paid" from durable evidence alone. Exactly one post-baseline
   * allocation is adoptable; zero is indistinguishable from a delayed provider commit and
   * more than one is undecidable — both fail closed and keep the wallet slot held.
   */
  private async resolveUncertain(
    cogniKey: string,
    allocationCursor: string
  ): Promise<AkashTxResource> {
    let adopted: ProvisionOutput | null;
    try {
      adopted = await this.console.findAllocationSince(allocationCursor);
    } catch (error) {
      const mapped = mapConsoleFailure(error, { mutating: false });
      this.log.error(
        { cogniKey, allocationCursor, code: mapped.code },
        "akash_tx_allocation_recovery_failed"
      );
      throw mapped;
    }
    if (!adopted) {
      this.log.error(
        { cogniKey, allocationCursor },
        "akash_tx_allocation_unresolved"
      );
      throw new AkashTxError(
        "allocation_unresolved",
        "a paid allocation may exist for this key and was not found; refusing to create"
      );
    }
    await this.ledger.recordAllocation({
      cogniKey,
      externalName: adopted.leaseId,
    });
    const record = await this.requireStoredHandle(
      cogniKey,
      adopted.leaseId,
      "create"
    );
    await this.bindCost(record, adopted.leaseId);
    await this.observeCost(record, adopted.leaseId);
    this.log.warn(
      { cogniKey, allocationCursor, externalName: adopted.leaseId },
      "akash_tx_allocation_recovered"
    );
    return resourceFrom(adopted);
  }

  private async describe(
    externalName: string,
    providerAccount?: string,
    record?: AkashTxAllocationRecord
  ): Promise<AkashTxResource> {
    try {
      const output = await this.console.status({ leaseId: externalName });
      if (record) await this.observeCost(record, externalName);
      return resourceFrom(output, providerAccount);
    } catch (error) {
      throw mapConsoleFailure(error, { mutating: false });
    }
  }

  private async withServing(
    observation: AkashTxObservation,
    expectedSourceSha: string | undefined
  ): Promise<AkashTxObservation> {
    const endpoints = observation.resource?.endpoints ?? [];
    if (!this.probe || !expectedSourceSha || endpoints.length === 0) {
      return observation;
    }
    const serving = await this.probe({ endpoints, expectedSourceSha });
    return { ...observation, serving };
  }

  private async readCursor(): Promise<string> {
    try {
      return await this.console.allocationCursor();
    } catch (error) {
      throw mapConsoleFailure(error, { mutating: false });
    }
  }

  private async claim(input: {
    cogniKey: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    spec: ProvisionSpec;
  }): Promise<Awaited<ReturnType<AkashTxAllocationLedgerPort["claim"]>>> {
    try {
      return await this.ledger.claim({
        cogniKey: input.cogniKey,
        workload: input.spec.name,
        environment: input.environment,
        identity: input.identity,
      });
    } catch (error) {
      throw this.ledgerUnavailable(error, input.cogniKey, "claim");
    }
  }

  private async bindIdentity(input: {
    cogniKey: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
  }): Promise<
    Awaited<ReturnType<AkashTxAllocationLedgerPort["bindIdentity"]>>
  > {
    try {
      return await this.ledger.bindIdentity({
        cogniKey: input.cogniKey,
        environment: input.environment,
        identity: input.identity,
      });
    } catch (error) {
      throw this.ledgerUnavailable(error, input.cogniKey, "bindIdentity");
    }
  }

  private async requireStoredHandle(
    cogniKey: string,
    externalName: string,
    operation: "observe" | "create" | "update" | "delete"
  ): Promise<AkashTxAllocationRecord> {
    const record = await this.readLedger(cogniKey);
    if (!record || record.externalName !== externalName) {
      this.log.error(
        {
          cogniKey,
          operation,
          requestedExternalName: externalName,
          ...(record?.externalName
            ? { boundExternalName: record.externalName }
            : {}),
        },
        record
          ? "akash_tx_resource_identity_conflict"
          : "akash_tx_receipt_absent"
      );
      throw new AkashTxError(
        "identity_conflict",
        "durable receipt does not bind this cogniKey to the requested resource"
      );
    }
    return record;
  }

  private async bindCost(
    record: AkashTxAllocationRecord,
    externalName: string
  ): Promise<void> {
    try {
      await this.costStore.bind({
        allocationReceiptId: record.receiptId,
        resource: {
          computeProvider: "akash",
          providerConsumerAccountId: this.providerConsumerAccountId,
          resourceId: externalName,
        },
      });
    } catch (error) {
      throw this.costUnavailable(error, record.cogniKey, "bind");
    }
  }

  private async observeCost(
    record: AkashTxAllocationRecord,
    externalName: string
  ): Promise<void> {
    await this.bindCost(record, externalName);
    try {
      const evidence = await this.costEvidence.observeCost({
        resourceId: externalName,
      });
      await this.costStore.observe({
        allocationReceiptId: record.receiptId,
        evidence,
      });
      this.log.info(
        {
          cogniKey: record.cogniKey,
          nodeId: record.identity.nodeId,
          externalName,
          rateAmount: evidence.rate.amount,
          rateDenom: evidence.rate.denom,
          rateUnit: evidence.rate.unit,
        },
        "compute_cost_observed"
      );
    } catch (error) {
      throw this.costUnavailable(error, record.cogniKey, "observe");
    }
  }

  private async closeCost(record: AkashTxAllocationRecord): Promise<void> {
    try {
      await this.costStore.close({ allocationReceiptId: record.receiptId });
    } catch (error) {
      throw this.costUnavailable(error, record.cogniKey, "close");
    }
  }

  private costUnavailable(
    error: unknown,
    cogniKey: string,
    operation: string
  ): AkashTxError {
    this.log.error(
      {
        cogniKey,
        operation,
        causeType: costFailureType(error),
      },
      "compute_cost_unavailable"
    );
    return new AkashTxError(
      "ledger_unavailable",
      "receipt-linked compute cost state unavailable; retry with the same key"
    );
  }

  /**
   * bug.5115 shape: a refusal that exists only in a status field is invisible. This one is a
   * structured log line FIRST — carrying both the claimed and the bound identity, which is the
   * only pair that explains the refusal — and a stable `identity_conflict` code second.
   */
  private identityConflict(input: {
    cogniKey: string;
    operation: "create" | "update";
    identity: AkashTxWorkloadIdentity;
    environment: string;
    record?: AkashTxAllocationRecord;
  }): AkashTxError {
    const absent = input.record === undefined;
    this.log.error(
      {
        cogniKey: input.cogniKey,
        operation: input.operation,
        ...identityFields(input.identity, input.environment),
        ...(input.record
          ? {
              boundNodeId: input.record.identity.nodeId,
              boundEnvironment: input.record.environment,
              boundCompositeUid: input.record.identity.compositeUid,
              ledgerState: input.record.state,
            }
          : {}),
      },
      absent ? "akash_tx_receipt_absent" : "akash_tx_identity_conflict"
    );
    return new AkashTxError(
      "identity_conflict",
      absent
        ? "no durable receipt binds this cogniKey; refusing to mutate a paid resource that cannot be attributed"
        : "this cogniKey is bound to a different node or environment; refusing to mis-attribute spend"
    );
  }

  private async prepare(cogniKey: string, cursor: string): Promise<void> {
    try {
      await this.ledger.prepare({ cogniKey, allocationCursor: cursor });
    } catch (error) {
      throw this.ledgerUnavailable(error, cogniKey, "prepare");
    }
  }

  private async readLedger(cogniKey: string) {
    try {
      return await this.ledger.read({ cogniKey });
    } catch (error) {
      throw this.ledgerUnavailable(error, cogniKey, "read");
    }
  }

  /** No receipt, no spending: a ledger failure is always a refusal, never a soft path. */
  private ledgerUnavailable(
    error: unknown,
    cogniKey: string,
    operation: string
  ): AkashTxError {
    if (error instanceof AkashTxError) return error;
    const code: AkashTxErrorCode = "ledger_unavailable";
    this.log.error(
      {
        cogniKey,
        operation,
        causeMessage: error instanceof Error ? error.message : "unknown cause",
      },
      "akash_tx_ledger_unavailable"
    );
    return new AkashTxError(code, "allocation ledger unavailable");
  }
}
