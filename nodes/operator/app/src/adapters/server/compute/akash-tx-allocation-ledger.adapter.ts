// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-tx-allocation-ledger.adapter`
 * Purpose: Durable custody of "we may have paid" — the Postgres implementation of the Akash
 *   allocation ledger behind the transaction actuator (task.5095). Holds the wallet-wide
 *   create slot and the pre-transaction cursor that makes a lost Console response recoverable,
 *   and lets a receipt whose transaction provably left nothing billing settle itself and be
 *   retried under the same key (bug.5192).
 * Scope: Reads/writes akash_tx_allocations. Contains no provider IO, no recovery policy, and
 *   no reconciliation — the actuator decides, the database enforces.
 * Invariants:
 *   - WALLET_SINGLE_WRITER: at most one row per wallet scope may be `preparing`. Enforced by
 *     the partial unique index, not by an in-process lock a crash can drop. The scope is the
 *     Console ACCOUNT (bug.5187), so the index serializes everything that can spend from one
 *     account rather than everything that happens to share a DEPLOY_ENVIRONMENT.
 *   - SCOPE_IS_HALF_THE_LOOKUP_KEY: `claimOnce` finds a prior receipt by
 *     `(wallet_scope, cogni_key)`. The scope this adapter is constructed with is therefore part
 *     of receipt IDENTITY — construct it with a value the stored rows do not carry and every
 *     existing receipt goes invisible, which reads as "nothing was ever created" and buys a
 *     second paid lease. Migration 0048 and the actuator's boot gate exist for exactly that.
 *   - HANDLE_IS_WRITE_ONCE: external_name is set with COALESCE — a recorded paid handle can
 *     never be overwritten by a later attempt under the same key.
 *   - PREPARE_REQUIRES_OWNERSHIP: writing the cursor fails when the key does not hold a
 *     `preparing` slot, so a resumed zombie can never proceed to spend.
 *   - IDENTITY_IS_WRITE_ONCE: node_id and composite_uid are written only by the claiming
 *     INSERT and appear in no UPDATE, so a receipt can never be re-pointed at another node.
 *     composite_generation advances with `greatest`, never backwards (task.5103).
 *   - NO_TIME_BASED_RELEASE: nothing here releases a slot on a timer. `listStalePreparing`
 *     REPORTS age and settles nothing; only `fail()` settles, and only for a receipt that
 *     never bound a handle, because releasing without evidence is how you pay twice (bug.5115
 *     is fixed by key-addressable resolution, not by expiry).
 *   - SETTLED_WITHOUT_A_HANDLE_IS_RETRYABLE: `claim` re-opens a receipt that is `failed` with
 *     `external_name IS NULL` for the SAME identity, because that state is only ever written
 *     with proof that nothing is billing — there is no spend to double-pay. A receipt that DID
 *     bind a handle stays terminally `settled`. Collapsing those two into one terminal state
 *     is what turned a single crashed create into a 33h account-wide outage (bug.5192).
 * Side-effects: IO (Postgres via the injected app-role Drizzle client)
 * Links: @ports/akash-tx.port, features/compute/akash-tx/akash-tx-actuator.ts,
 *   features/compute/akash-tx/akash-tx-wallet.ts (resolves the wallet scope this serializes),
 *   @shared/db/akash-tx-allocations (operator-local table, NOT @cogni/db-schema), task.5095,
 *   task.5103
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type {
  AkashPreviewAdmission,
  AkashPreviewAdmissionInput,
  AkashPreviewAdmissionPort,
  AkashTxAllocationLedgerPort,
  AkashTxAllocationRecord,
  AkashTxAllocationState,
  AkashTxStaleAllocation,
  AkashTxWorkloadIdentity,
} from "@/ports";
import { AkashPreviewAdmissionError } from "@/ports";
import { akashPreviewAdmissions, akashTxAllocations } from "@/shared/db/schema";
import { DatabaseCellAllocationMetadataSchema } from "@/shared/secrets/database-cell-placement.data";

interface AllocationRow {
  previewDeploymentId: string | null;
  previewSubmittedAt: Date | null;
  previewDispatchFinishedAt: Date | null;
  id: string;
  cogniKey: string;
  nodeId: string;
  compositeUid: string;
  compositeGeneration: number;
  workload: string;
  environment: string;
  state: string;
  allocationCursor: string | null;
  externalName: string | null;
  providerAccount: string | null;
  lastAppliedSdlHash: string | null;
  appliedDatabaseCellBinding: unknown;
}

const SELECTION = {
  previewDeploymentId: akashTxAllocations.previewDeploymentId,
  previewSubmittedAt: akashTxAllocations.previewSubmittedAt,
  previewDispatchFinishedAt: akashTxAllocations.previewDispatchFinishedAt,
  id: akashTxAllocations.id,
  cogniKey: akashTxAllocations.cogniKey,
  nodeId: akashTxAllocations.nodeId,
  compositeUid: akashTxAllocations.compositeUid,
  compositeGeneration: akashTxAllocations.compositeGeneration,
  workload: akashTxAllocations.workload,
  environment: akashTxAllocations.environment,
  state: akashTxAllocations.state,
  allocationCursor: akashTxAllocations.allocationCursor,
  externalName: akashTxAllocations.externalName,
  providerAccount: akashTxAllocations.providerAccount,
  lastAppliedSdlHash: akashTxAllocations.lastAppliedSdlHash,
  appliedDatabaseCellBinding: akashTxAllocations.appliedDatabaseCellBinding,
};

function toRecord(row: AllocationRow): AkashTxAllocationRecord {
  const metadata = DatabaseCellAllocationMetadataSchema.parse(
    row.appliedDatabaseCellBinding ?? []
  );
  return {
    ...(row.previewDeploymentId
      ? { previewDeploymentId: row.previewDeploymentId }
      : {}),
    ...(row.previewSubmittedAt
      ? { previewSubmittedAt: row.previewSubmittedAt }
      : {}),
    ...(row.previewDispatchFinishedAt
      ? { previewDispatchFinishedAt: row.previewDispatchFinishedAt }
      : {}),
    ...(metadata.retentionPolicy
      ? { retentionPolicy: metadata.retentionPolicy }
      : {}),
    ...(row.appliedDatabaseCellBinding == null
      ? {}
      : { appliedDatabaseCellBinding: metadata.bindings }),
    receiptId: row.id,
    cogniKey: row.cogniKey,
    identity: {
      nodeId: row.nodeId,
      compositeUid: row.compositeUid,
      compositeGeneration: row.compositeGeneration,
    },
    workload: row.workload,
    environment: row.environment,
    state: row.state as AkashTxAllocationState,
    ...(row.allocationCursor ? { allocationCursor: row.allocationCursor } : {}),
    ...(row.externalName ? { externalName: row.externalName } : {}),
    ...(row.providerAccount ? { providerAccount: row.providerAccount } : {}),
    ...(row.lastAppliedSdlHash
      ? { lastAppliedSdlHash: row.lastAppliedSdlHash }
      : {}),
  };
}

type LedgerTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type PreviewRow = typeof akashPreviewAdmissions.$inferSelect;

function previewRecord(row: PreviewRow): AkashPreviewAdmission {
  return {
    deploymentId: row.deploymentId,
    nodeId: row.nodeId,
    environment: row.environment,
    requestKey: row.requestKey,
    payloadHash: row.payloadHash,
    sourceSha: row.sourceSha,
    artifactRef: row.artifactRef,
    bundleRef: row.bundleRef,
    expiresAt: row.expiresAt,
    stateSlot: row.stateSlot as 0 | 1,
    ...(row.resolvedSdlHash ? { resolvedSdlHash: row.resolvedSdlHash } : {}),
    ...(row.resetGeneration ? { resetGeneration: row.resetGeneration } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    ...(row.closureObservedAt
      ? { closureObservedAt: row.closureObservedAt }
      : {}),
  };
}

/** Postgres unique-violation — the database refusing a concurrent second wallet writer. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === "23505") return true;
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  return cause?.code === "23505";
}

export class DrizzleAkashTxAllocationLedger
  implements AkashTxAllocationLedgerPort
{
  /**
   * @param walletScope opaque identity of the Console wallet this ledger serializes. One
   *   scope = one writer. Two actuators pointed at the SAME Console wallet MUST share a
   *   scope and a database, or cursor-based recovery is unsound. Callers MUST obtain this
   *   from `resolveAkashTxWallet`, which refuses any credential the legacy ComputeWorkload
   *   controller already spends from (ONE_WALLET_ONE_WRITER).
   */
  constructor(
    private readonly getDb: () => Promise<Database>,
    private readonly walletScope: string
  ) {}

  readonly preview: AkashPreviewAdmissionPort = {
    admit: (input) => this.admitPreview(input),
    cancel: (input) => this.admitPreview(input, true),
    withUnallocatedStateReservation: (deploymentId, stateSlot, action) =>
      this.withUnallocatedStateReservation(deploymentId, stateSlot, action),
    withActiveState: async (input, action) => {
      const db = await this.getDb();
      return db.transaction(async (tx) => {
        const admission = await this.lockPreview(tx, input.deploymentId, true);
        if (
          admission.stateSlot !== input.stateSlot ||
          admission.resetGeneration !== input.resetGeneration
        )
          throw new AkashPreviewAdmissionError("conflict");
        return action();
      });
    },
    bindResolvedSpec: async (input) => {
      const db = await this.getDb();
      await db.transaction(async (tx) => {
        const admission = await this.lockPreview(tx, input.deploymentId, true);
        if (
          admission.sourceSha !== input.sourceSha ||
          admission.artifactRef !== input.artifactRef ||
          (admission.resolvedSdlHash &&
            admission.resolvedSdlHash !== input.sdlHash)
        )
          throw new AkashPreviewAdmissionError("conflict");
        await tx
          .update(akashPreviewAdmissions)
          .set({ resolvedSdlHash: input.sdlHash })
          .where(eq(akashPreviewAdmissions.deploymentId, input.deploymentId));
      });
    },
    read: (id) => this.readPreview(id),
    revoke: (id) => this.revokePreview(id),
    assertActive: async (input) => {
      const db = await this.getDb();
      await db.transaction(async (tx) => {
        const row = await this.lockPreview(tx, input.deploymentId, true);
        if (
          row.nodeId !== input.nodeId ||
          row.environment !== input.environment
        )
          throw new AkashPreviewAdmissionError("conflict");
      });
    },
    beforeProviderTransaction: (input) => this.beforePreviewTransaction(input),
    finishDispatch: (input) => this.finishPreviewDispatch(input),
    receipts: (id) => this.previewReceipts(id),
    finishRetirement: (input) => this.finishPreviewRetirement(input),
  };

  /** One lock order everywhere: admission first, then its allocation receipts. */
  private async lockPreview(
    tx: LedgerTransaction,
    deploymentId: string,
    active: boolean
  ): Promise<PreviewRow> {
    const [row] = await tx
      .select()
      .from(akashPreviewAdmissions)
      .where(
        and(
          eq(akashPreviewAdmissions.walletScope, this.walletScope),
          eq(akashPreviewAdmissions.deploymentId, deploymentId)
        )
      )
      .for("update");
    if (!row) throw new AkashPreviewAdmissionError("missing");
    if (active) {
      if (row.revokedAt || row.closureObservedAt)
        throw new AkashPreviewAdmissionError("terminal");
      // Read AFTER obtaining the row lock; transaction-start now() is stale after a wait.
      const [clock] = await tx
        .select({
          expired: sql<boolean>`${akashPreviewAdmissions.expiresAt} <= clock_timestamp()`,
        })
        .from(akashPreviewAdmissions)
        .where(eq(akashPreviewAdmissions.deploymentId, deploymentId));
      if (clock?.expired) throw new AkashPreviewAdmissionError("expired");
    }
    return row;
  }

  private async admitPreview(
    input: AkashPreviewAdmissionInput,
    cancel = false
  ): Promise<AkashPreviewAdmission> {
    const db = await this.getDb();
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${input.deploymentId}))`
      );
      // Admission quota only, not a second paid-wallet lock. Two reusable state pairs bound the pilot.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${this.walletScope}))`
      );
      const [existing] = await tx
        .select()
        .from(akashPreviewAdmissions)
        .where(
          or(
            and(
              eq(akashPreviewAdmissions.walletScope, this.walletScope),
              eq(akashPreviewAdmissions.requestKey, input.requestKey)
            ),
            eq(akashPreviewAdmissions.deploymentId, input.deploymentId)
          )
        )
        .for("update");
      if (existing) {
        if (
          existing.deploymentId !== input.deploymentId ||
          existing.walletScope !== this.walletScope ||
          existing.nodeId !== input.nodeId ||
          existing.environment !== input.environment ||
          existing.requestKey !== input.requestKey ||
          existing.payloadHash !== input.payloadHash ||
          existing.sourceSha !== input.sourceSha ||
          existing.artifactRef !== input.artifactRef ||
          existing.bundleRef !== input.bundleRef ||
          existing.expiresAt.getTime() !== input.expiresAt.getTime()
        )
          throw new AkashPreviewAdmissionError("conflict");
        if (cancel && !existing.revokedAt) {
          const [revoked] = await tx
            .update(akashPreviewAdmissions)
            .set({ revokedAt: sql`clock_timestamp()` })
            .where(eq(akashPreviewAdmissions.deploymentId, input.deploymentId))
            .returning();
          if (!revoked) throw new AkashPreviewAdmissionError("missing");
          return previewRecord(revoked);
        }
        return previewRecord(existing); // Terminal requests stay terminal; they never reacquire a slot.
      }
      const occupied = await tx
        .select({ slot: akashPreviewAdmissions.stateSlot })
        .from(akashPreviewAdmissions)
        .where(
          and(
            eq(akashPreviewAdmissions.walletScope, this.walletScope),
            isNull(akashPreviewAdmissions.closureObservedAt)
          )
        );
      const stateSlot = ([0, 1] as const).find(
        (slot) => !occupied.some((row) => row.slot === slot)
      );
      if (!cancel && stateSlot === undefined)
        throw new AkashPreviewAdmissionError("capacity");
      const [inserted] = await tx
        .insert(akashPreviewAdmissions)
        .values({
          ...input,
          walletScope: this.walletScope,
          stateSlot: stateSlot ?? 0,
          ...(cancel
            ? {
                revokedAt: sql`clock_timestamp()`,
                closureObservedAt: sql`clock_timestamp()`,
              }
            : {}),
        })
        .returning();
      if (!inserted) throw new AkashPreviewAdmissionError("conflict");
      return previewRecord(inserted);
    });
  }

  private async withUnallocatedStateReservation<
    T extends { resetGeneration: string },
  >(
    deploymentId: string,
    stateSlot: 0 | 1,
    action: () => Promise<T>
  ): Promise<T> {
    const db = await this.getDb();
    return db.transaction(async (tx) => {
      const admission = await this.lockPreview(tx, deploymentId, true);
      if (admission.stateSlot !== stateSlot || admission.resetGeneration)
        throw new AkashPreviewAdmissionError("conflict");
      const receipts = await tx
        .select(SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.previewDeploymentId, deploymentId)
          )
        )
        .for("update");
      if (receipts.some((row) => row.previewSubmittedAt || row.externalName))
        throw new AkashPreviewAdmissionError("unresolved");
      // The caller's bounded TEST DB/Kubernetes action must not re-enter this ledger.
      const result = await action();
      await tx
        .update(akashPreviewAdmissions)
        .set({ resetGeneration: result.resetGeneration })
        .where(eq(akashPreviewAdmissions.deploymentId, deploymentId));
      return result;
    });
  }

  private async readPreview(
    deploymentId: string
  ): Promise<AkashPreviewAdmission | null> {
    const db = await this.getDb();
    const [row] = await db
      .select()
      .from(akashPreviewAdmissions)
      .where(
        and(
          eq(akashPreviewAdmissions.walletScope, this.walletScope),
          eq(akashPreviewAdmissions.deploymentId, deploymentId)
        )
      );
    return row ? previewRecord(row) : null;
  }

  private async revokePreview(
    deploymentId: string
  ): Promise<AkashPreviewAdmission> {
    const db = await this.getDb();
    return db.transaction(async (tx) => {
      await this.lockPreview(tx, deploymentId, false);
      const [row] = await tx
        .update(akashPreviewAdmissions)
        .set({
          revokedAt: sql`coalesce(${akashPreviewAdmissions.revokedAt}, clock_timestamp())`,
        })
        .where(eq(akashPreviewAdmissions.deploymentId, deploymentId))
        .returning();
      if (!row) throw new AkashPreviewAdmissionError("missing");
      return previewRecord(row);
    });
  }

  private async beforePreviewTransaction(input: {
    deploymentId: string;
    cogniKey: string;
    phase: "deployment" | "lease";
  }): Promise<void> {
    const db = await this.getDb();
    await db.transaction(async (tx) => {
      const admission = await this.lockPreview(tx, input.deploymentId, true);
      if (!admission.resetGeneration || !admission.resolvedSdlHash)
        throw new AkashPreviewAdmissionError("unresolved");
      const [row] = await tx
        .select(SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey)
          )
        )
        .for("update");
      if (!row || row.previewDeploymentId !== input.deploymentId)
        throw new AkashPreviewAdmissionError("conflict");
      if (row.state !== "preparing" && row.state !== "allocated")
        throw new AkashPreviewAdmissionError("terminal");
      if (input.phase === "deployment") {
        const family = await tx
          .select(SELECTION)
          .from(akashTxAllocations)
          .where(
            and(
              eq(akashTxAllocations.walletScope, this.walletScope),
              eq(akashTxAllocations.previewDeploymentId, input.deploymentId)
            )
          );
        if (
          family.some(
            (other) =>
              other.id !== row.id &&
              (other.previewSubmittedAt || other.externalName)
          )
        )
          throw new AkashPreviewAdmissionError("unresolved");
      }
      if (input.phase === "deployment" && row.previewSubmittedAt)
        throw new AkashPreviewAdmissionError("unresolved");
      if (
        input.phase === "lease" &&
        (!row.previewSubmittedAt || !row.externalName)
      )
        throw new AkashPreviewAdmissionError("conflict");
      await tx
        .update(akashTxAllocations)
        .set({
          previewSubmittedAt: sql`coalesce(${akashTxAllocations.previewSubmittedAt}, clock_timestamp())`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(akashTxAllocations.id, row.id));
    });
  }

  private async finishPreviewDispatch(input: {
    deploymentId: string;
    cogniKey: string;
  }): Promise<void> {
    const db = await this.getDb();
    await db.transaction(async (tx) => {
      await this.lockPreview(tx, input.deploymentId, false);
      await tx
        .update(akashTxAllocations)
        .set({ previewDispatchFinishedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey),
            eq(akashTxAllocations.previewDeploymentId, input.deploymentId)
          )
        );
    });
  }

  private async previewReceipts(
    deploymentId: string
  ): Promise<readonly AkashTxAllocationRecord[]> {
    const db = await this.getDb();
    // No LIMIT: incomplete enumeration cannot authorize freeing an admission slot.
    const rows = await db
      .select(SELECTION)
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.previewDeploymentId, deploymentId)
        )
      );
    return rows.map(toRecord);
  }

  private async finishPreviewRetirement(input: {
    deploymentId: string;
    observedClosedReceiptIds: readonly string[];
  }): Promise<AkashPreviewAdmission> {
    const db = await this.getDb();
    return db.transaction(async (tx) => {
      const admission = await this.lockPreview(tx, input.deploymentId, false);
      if (!admission.revokedAt)
        throw new AkashPreviewAdmissionError("unresolved");
      if (admission.closureObservedAt) return previewRecord(admission);
      const rows = await tx
        .select(SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.previewDeploymentId, input.deploymentId)
          )
        )
        .for("update");
      const observed = new Set(input.observedClosedReceiptIds);
      if (
        rows.some((row) =>
          row.externalName
            ? row.state !== "released" || !observed.has(row.id)
            : Boolean(row.previewSubmittedAt) || row.state !== "failed"
        )
      )
        throw new AkashPreviewAdmissionError("unresolved");
      const [closed] = await tx
        .update(akashPreviewAdmissions)
        .set({ closureObservedAt: sql`clock_timestamp()` })
        .where(eq(akashPreviewAdmissions.deploymentId, input.deploymentId))
        .returning();
      if (!closed) throw new AkashPreviewAdmissionError("missing");
      return previewRecord(closed);
    });
  }

  async claim(input: {
    cogniKey: string;
    workload: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    retentionPolicy?: "retain";
    previewDeploymentId?: string;
  }): Promise<
    | { state: "claimed"; record: AkashTxAllocationRecord }
    | { state: "owned"; record: AkashTxAllocationRecord }
    | { state: "settled"; record: AkashTxAllocationRecord }
    | { state: "blocked"; ownerCogniKey: string }
  > {
    try {
      return await this.claimOnce(input);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent claimant won the race. The second pass reads its committed row and
      // answers deterministically (owned / blocked) — this is CAS resolution, not a retry loop.
      return this.claimOnce(input);
    }
  }

  private async claimOnce(input: {
    cogniKey: string;
    workload: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    retentionPolicy?: "retain";
    previewDeploymentId?: string;
  }): Promise<
    | { state: "claimed"; record: AkashTxAllocationRecord }
    | { state: "owned"; record: AkashTxAllocationRecord }
    | { state: "settled"; record: AkashTxAllocationRecord }
    | { state: "blocked"; ownerCogniKey: string }
  > {
    const db = await this.getDb();
    return db.transaction(async (tx) => {
      // Read only a hint before locking. A preview-bound receipt can never downgrade to
      // ordinary behavior when a retry omits preview identity.
      const [hint] = await tx
        .select({ previewDeploymentId: akashTxAllocations.previewDeploymentId })
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey)
          )
        );
      const previewId = input.previewDeploymentId ?? hint?.previewDeploymentId;
      if (previewId) {
        if (input.previewDeploymentId !== previewId)
          throw new AkashPreviewAdmissionError("conflict");
        const admission = await this.lockPreview(tx, previewId, true);
        if (
          admission.nodeId !== input.identity.nodeId ||
          admission.environment !== input.environment
        )
          throw new AkashPreviewAdmissionError("conflict");
        const family = await tx
          .select(SELECTION)
          .from(akashTxAllocations)
          .where(
            and(
              eq(akashTxAllocations.walletScope, this.walletScope),
              eq(akashTxAllocations.previewDeploymentId, previewId)
            )
          );
        if (
          family.some(
            (other) =>
              other.cogniKey !== input.cogniKey &&
              (other.previewSubmittedAt || other.externalName)
          )
        )
          throw new AkashPreviewAdmissionError("unresolved");
      }
      const [existing] = await tx
        .select(SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey)
          )
        )
        .for("update")
        .limit(1);
      if (
        existing &&
        (existing.previewDeploymentId ?? undefined) !==
          input.previewDeploymentId
      )
        throw new AkashPreviewAdmissionError("conflict");
      if (existing && existing.state === "preparing") {
        if (
          input.retentionPolicy &&
          existing.nodeId === input.identity.nodeId &&
          existing.environment === input.environment &&
          existing.compositeUid === input.identity.compositeUid
        ) {
          const metadata = DatabaseCellAllocationMetadataSchema.parse(
            existing.appliedDatabaseCellBinding ?? []
          );
          const retained = {
            version: 1,
            retentionPolicy: "retain",
            bindings: metadata.bindings,
          };
          await tx
            .update(akashTxAllocations)
            .set({ appliedDatabaseCellBinding: retained })
            .where(
              and(
                eq(akashTxAllocations.walletScope, this.walletScope),
                eq(akashTxAllocations.id, existing.id)
              )
            );
          existing.appliedDatabaseCellBinding = retained;
        }
        return { state: "owned" as const, record: toRecord(existing) };
      }
      // A receipt that bound a handle is terminal forever (HANDLE_IS_WRITE_ONCE). One settled
      // `failed` with NO handle is the opposite case: it was written WITH proof that nothing is
      // billing, so there is nothing to double-pay and the key may take a clean slot again.
      // Identity must still match: re-opening a receipt bound to another node would move spend
      // attribution, so a mismatch stays `settled` and the actuator raises identity_conflict.
      const reclaimable =
        existing !== undefined &&
        existing.state === "failed" &&
        existing.externalName === null &&
        existing.previewSubmittedAt === null &&
        existing.nodeId === input.identity.nodeId &&
        existing.environment === input.environment &&
        existing.compositeUid === input.identity.compositeUid;
      if (existing && !reclaimable) {
        return { state: "settled" as const, record: toRecord(existing) };
      }

      const [holder] = await tx
        .select({ cogniKey: akashTxAllocations.cogniKey })
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.state, "preparing")
          )
        )
        .limit(1);
      if (holder) {
        return { state: "blocked" as const, ownerCogniKey: holder.cogniKey };
      }

      if (reclaimable) {
        const [reopened] = await tx
          .update(akashTxAllocations)
          .set({
            state: "preparing",
            ...(input.retentionPolicy
              ? {
                  appliedDatabaseCellBinding: {
                    version: 1,
                    retentionPolicy: "retain",
                    bindings: DatabaseCellAllocationMetadataSchema.parse(
                      existing.appliedDatabaseCellBinding ?? []
                    ).bindings,
                  },
                }
              : {}),
            // The previous attempt's baseline described a transaction that is now settled.
            // Carrying it forward would point the next recovery scan at the wrong high-water
            // mark and make an unrelated later deployment look adoptable.
            allocationCursor: null,
            failureCode: null,
            ...(input.previewDeploymentId
              ? { previewSubmittedAt: null, previewDispatchFinishedAt: null }
              : {}),
            settledAt: null,
            workload: input.workload,
            compositeGeneration: sql`greatest(${akashTxAllocations.compositeGeneration}, ${input.identity.compositeGeneration}::int)`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(akashTxAllocations.walletScope, this.walletScope),
              eq(akashTxAllocations.cogniKey, input.cogniKey),
              // Re-assert the proof conditions inside the write: concurrent state can only
              // have moved AWAY from "settled with no handle", never back into it.
              eq(akashTxAllocations.state, "failed"),
              sql`${akashTxAllocations.externalName} is null`
            )
          )
          .returning(SELECTION);
        if (!reopened) {
          throw new Error("akash_tx_allocations re-claim returned no row");
        }
        return { state: "claimed" as const, record: toRecord(reopened) };
      }

      const [inserted] = await tx
        .insert(akashTxAllocations)
        .values({
          walletScope: this.walletScope,
          cogniKey: input.cogniKey,
          // IDENTITY_BEFORE_TRANSACTION — the columns are NOT NULL, so the row that opens the
          // wallet slot physically cannot exist without saying which node it is for.
          nodeId: input.identity.nodeId,
          compositeUid: input.identity.compositeUid,
          compositeGeneration: input.identity.compositeGeneration,
          workload: input.workload,
          environment: input.environment,
          state: "preparing",
          ...(input.previewDeploymentId
            ? { previewDeploymentId: input.previewDeploymentId }
            : {}),
          ...(input.retentionPolicy
            ? {
                appliedDatabaseCellBinding: {
                  version: 1,
                  retentionPolicy: "retain",
                  bindings: [],
                },
              }
            : {}),
        })
        .returning(SELECTION);
      if (!inserted) {
        throw new Error("akash_tx_allocations insert returned no row");
      }
      return { state: "claimed" as const, record: toRecord(inserted) };
    });
  }

  /**
   * Bind an existing receipt to the identity of a non-create mutation. Reads under a row lock,
   * reports a mismatch rather than healing it, and advances the observed generation with
   * `greatest` so a delayed retry can never walk the receipt backwards.
   *
   * node_id and composite_uid are deliberately absent from the UPDATE: IDENTITY_IS_WRITE_ONCE.
   */
  async bindIdentity(input: {
    cogniKey: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    retentionPolicy?: "retain";
  }): Promise<
    | { state: "bound"; record: AkashTxAllocationRecord }
    | { state: "absent" }
    | { state: "conflict"; record: AkashTxAllocationRecord }
  > {
    const db = await this.getDb();
    return db.transaction(async (tx) => {
      const [hint] = await tx
        .select({ previewDeploymentId: akashTxAllocations.previewDeploymentId })
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey)
          )
        );
      if (hint?.previewDeploymentId) {
        const admission = await this.lockPreview(
          tx,
          hint.previewDeploymentId,
          true
        );
        if (
          admission.nodeId !== input.identity.nodeId ||
          admission.environment !== input.environment
        )
          throw new AkashPreviewAdmissionError("conflict");
      }
      const [existing] = await tx
        .select(SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey)
          )
        )
        .for("update")
        .limit(1);
      if (
        existing?.previewDeploymentId &&
        existing.previewDeploymentId !== hint?.previewDeploymentId
      )
        throw new AkashPreviewAdmissionError("conflict");
      if (!existing) return { state: "absent" as const };
      if (
        existing.nodeId !== input.identity.nodeId ||
        existing.environment !== input.environment ||
        existing.compositeUid !== input.identity.compositeUid
      ) {
        return { state: "conflict" as const, record: toRecord(existing) };
      }

      const [updated] = await tx
        .update(akashTxAllocations)
        .set({
          compositeGeneration: sql`greatest(${akashTxAllocations.compositeGeneration}, ${input.identity.compositeGeneration}::int)`,
          ...(input.retentionPolicy
            ? {
                appliedDatabaseCellBinding: {
                  version: 1,
                  retentionPolicy: "retain",
                  bindings: DatabaseCellAllocationMetadataSchema.parse(
                    existing.appliedDatabaseCellBinding ?? []
                  ).bindings,
                },
              }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey)
          )
        )
        .returning(SELECTION);
      if (!updated) {
        throw new Error("akash_tx_allocations identity bind returned no row");
      }
      return { state: "bound" as const, record: toRecord(updated) };
    });
  }

  async prepare(input: {
    cogniKey: string;
    allocationCursor: string;
    previewDeploymentId?: string;
  }): Promise<void> {
    const db = await this.getDb();
    const prepare = async (writer: Database | LedgerTransaction) => {
      const updated = await writer
        .update(akashTxAllocations)
        .set({
          allocationCursor: input.allocationCursor,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey),
            eq(akashTxAllocations.state, "preparing"),
            input.previewDeploymentId
              ? isNull(akashTxAllocations.previewSubmittedAt)
              : sql`true`,
            input.previewDeploymentId
              ? eq(
                  akashTxAllocations.previewDeploymentId,
                  input.previewDeploymentId
                )
              : isNull(akashTxAllocations.previewDeploymentId)
          )
        )
        .returning({ cogniKey: akashTxAllocations.cogniKey });
      if (updated.length === 0) {
        throw new Error(
          "cannot record a pre-transaction cursor without owning the wallet slot"
        );
      }
    };
    const deploymentId = input.previewDeploymentId;
    if (deploymentId) {
      await db.transaction(async (tx) => {
        await this.lockPreview(tx, deploymentId, true);
        await prepare(tx);
      });
    } else await prepare(db);
  }

  async recordAllocation(input: {
    cogniKey: string;
    externalName: string;
    providerAccount?: string;
  }): Promise<void> {
    const db = await this.getDb();
    const updated = await db
      .update(akashTxAllocations)
      .set({
        state: "allocated",
        // HANDLE_IS_WRITE_ONCE — the first durable handle wins, forever.
        externalName: sql`coalesce(${akashTxAllocations.externalName}, ${input.externalName})`,
        providerAccount: input.providerAccount
          ? sql`coalesce(${akashTxAllocations.providerAccount}, ${input.providerAccount})`
          : akashTxAllocations.providerAccount,
        settledAt: sql`coalesce(${akashTxAllocations.settledAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.cogniKey, input.cogniKey),
          sql`${akashTxAllocations.state} in ('preparing', 'allocated')`
        )
      )
      .returning({ cogniKey: akashTxAllocations.cogniKey });
    if (updated.length === 0) {
      throw new Error(
        "cannot record an allocation for a key with no live wallet slot"
      );
    }
  }

  /**
   * Persist the sha256 of the SDL just applied for this key (bug.5238). Advisory metadata: it
   * touches neither the wallet slot, the state machine, nor any write-once identity column, so it
   * carries no state predicate beyond the key — the update path only ever calls it on a receipt
   * it has already bound. Called AFTER a successful `updateAllocated`, so a lost PUT re-applies
   * next reconcile rather than being skipped forever.
   */
  async recordAppliedSdlHash(input: {
    cogniKey: string;
    sdlHash: string;
  }): Promise<void> {
    const db = await this.getDb();
    const updated = await db
      .update(akashTxAllocations)
      .set({
        lastAppliedSdlHash: input.sdlHash,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.cogniKey, input.cogniKey)
        )
      )
      .returning({ cogniKey: akashTxAllocations.cogniKey });
    if (updated.length === 0) {
      throw new Error(
        "cannot record an applied SDL hash for a key with no receipt"
      );
    }
  }

  /**
   * Receipts that have held the wallet slot longer than any single transaction can take.
   * A pure read that decides nothing: age makes a row eligible to be INVESTIGATED, never
   * settled (NO_TIME_BASED_RELEASE). Oldest first and hard-limited, so one pass is bounded.
   */
  async listStalePreparing(input: {
    olderThanMs: number;
    limit: number;
  }): Promise<readonly AkashTxStaleAllocation[]> {
    const db = await this.getDb();
    const rows = await db
      .select({
        previewDeploymentId: akashTxAllocations.previewDeploymentId,
        cogniKey: akashTxAllocations.cogniKey,
        allocationCursor: akashTxAllocations.allocationCursor,
        // Age is computed BY POSTGRES: the actuator's clock is not the ledger's clock, and a
        // skewed pod must not be able to declare a fresh receipt stale.
        heldForMs: sql<number>`floor(extract(epoch from (now() - ${akashTxAllocations.updatedAt})) * 1000)::int`,
      })
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.state, "preparing"),
          sql`${akashTxAllocations.externalName} is null`,
          sql`${akashTxAllocations.updatedAt} < now() - make_interval(secs => ${input.olderThanMs / 1000})`
        )
      )
      .orderBy(akashTxAllocations.updatedAt)
      .limit(input.limit);
    return rows.map((row) => ({
      ...(row.previewDeploymentId
        ? { previewDeploymentId: row.previewDeploymentId }
        : {}),
      cogniKey: row.cogniKey,
      ...(row.allocationCursor
        ? { allocationCursor: row.allocationCursor }
        : {}),
      heldForMs: Number(row.heldForMs),
    }));
  }

  /**
   * Settle a receipt that never bound a handle, releasing the wallet-wide slot.
   *
   * The WHERE clause is the half of the contract this layer can enforce: `preparing` AND
   * `external_name is null`, so a recorded paid handle can never be erased by a failure path.
   * The other half — positive evidence that nothing is billing — belongs to the caller, and is
   * why every call site either has no cursor (provably pre-transaction) or a Console read-back
   * proving the deployment closed.
   */
  async fail(input: { cogniKey: string; failureCode: string }): Promise<void> {
    const db = await this.getDb();
    await db
      .update(akashTxAllocations)
      .set({
        state: "failed",
        failureCode: input.failureCode,
        settledAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.cogniKey, input.cogniKey),
          eq(akashTxAllocations.state, "preparing"),
          sql`${akashTxAllocations.externalName} is null`,
          or(
            isNull(akashTxAllocations.previewDeploymentId),
            isNull(akashTxAllocations.previewSubmittedAt)
          )
        )
      );
  }

  async markReleased(input: { cogniKey: string }): Promise<void> {
    const db = await this.getDb();
    await db
      .update(akashTxAllocations)
      .set({
        state: "released",
        settledAt: sql`coalesce(${akashTxAllocations.settledAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.cogniKey, input.cogniKey),
          sql`${akashTxAllocations.state} in ('allocated', 'released')`
        )
      );
  }

  /**
   * The wallet's live paid leases: `allocated` receipts that bound a provider handle. A pure
   * read that decides nothing (story.5039's SEE primitive) — ordered by `updated_at` so the
   * longest-untouched receipt surfaces first, hard-limited so one pass is bounded, and always
   * scoped to THIS wallet like every other method. Optional `nodeId`/`environment` narrowing
   * uses the existing `(node_id, environment)` index; the UNFILTERED scan is the orphan-diff
   * primitive (a lease whose pair the catalog no longer declares matches no filter).
   */
  async listAllocated(input: {
    nodeId?: string;
    environment?: string;
    limit: number;
  }): Promise<readonly AkashTxAllocationRecord[]> {
    const db = await this.getDb();
    const rows = await db
      .select(SELECTION)
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.state, "allocated"),
          sql`${akashTxAllocations.externalName} is not null`,
          ...(input.nodeId
            ? [eq(akashTxAllocations.nodeId, input.nodeId)]
            : []),
          ...(input.environment
            ? [eq(akashTxAllocations.environment, input.environment)]
            : [])
        )
      )
      .orderBy(akashTxAllocations.updatedAt)
      .limit(input.limit);
    return rows.map(toRecord);
  }

  /**
   * The wallet's live (non-terminal) receipts: `state IN ('preparing','allocated')` — the
   * boot-window-inclusive log-source primitive (bug.5264). Unlike `listAllocated` this keeps
   * `preparing` receipts (create in-flight, or a handle bound by an adopt/resolve pass) and
   * does NOT require a handle, so a lease that is BOOTING but not yet `allocated` — and would
   * otherwise be closed on its BootDeadline before the pump ever enumerated it — is visible for
   * log tailing, and a live handleless receipt is loggable rather than invisibly absent. Same
   * scoping/ordering/limit discipline as `listAllocated`; a pure read that decides nothing.
   */
  async listActive(input: {
    nodeId?: string;
    environment?: string;
    limit: number;
  }): Promise<readonly AkashTxAllocationRecord[]> {
    const db = await this.getDb();
    const rows = await db
      .select(SELECTION)
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          inArray(akashTxAllocations.state, ["preparing", "allocated"]),
          ...(input.nodeId
            ? [eq(akashTxAllocations.nodeId, input.nodeId)]
            : []),
          ...(input.environment
            ? [eq(akashTxAllocations.environment, input.environment)]
            : [])
        )
      )
      .orderBy(akashTxAllocations.updatedAt)
      .limit(input.limit);
    return rows.map(toRecord);
  }

  /**
   * Every-state enumeration for generation derivation (task.5132) — same scoping as
   * `listAllocated` (walletScope always, optional `(node_id, environment)` narrowing), no state
   * or handle predicate: terminal `released`/`failed` receipts are exactly the evidence
   * `requiredLeaseGeneration` exists to count, and the allocated-only view hid them.
   */
  async listReceipts(input: {
    nodeId?: string;
    environment?: string;
    limit: number;
  }): Promise<readonly AkashTxAllocationRecord[]> {
    const db = await this.getDb();
    const rows = await db
      .select(SELECTION)
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          ...(input.nodeId
            ? [eq(akashTxAllocations.nodeId, input.nodeId)]
            : []),
          ...(input.environment
            ? [eq(akashTxAllocations.environment, input.environment)]
            : [])
        )
      )
      .orderBy(akashTxAllocations.updatedAt)
      .limit(input.limit);
    return rows.map(toRecord);
  }

  async read(input: {
    cogniKey: string;
  }): Promise<AkashTxAllocationRecord | null> {
    const db = await this.getDb();
    const [row] = await db
      .select(SELECTION)
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.cogniKey, input.cogniKey)
        )
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }
}
