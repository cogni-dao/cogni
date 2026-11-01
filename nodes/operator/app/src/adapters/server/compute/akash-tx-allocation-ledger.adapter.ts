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
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type {
  AkashTxAllocationLedgerPort,
  AkashTxAllocationRecord,
  AkashTxAllocationState,
  AkashTxStaleAllocation,
  AkashTxWorkloadIdentity,
} from "@/ports";
import { akashTxAllocations } from "@/shared/db/schema";
import { DatabaseCellAllocationMetadataSchema } from "@/shared/secrets/database-cell-placement.data";
import type { AkashNativeWalletInventory } from "@/types/akash-native-state";
import {
  advanceReceiptVersion,
  receiptFence,
  receiptTransaction,
  receiptVersion,
} from "./akash-receipt-transaction";

interface AllocationRow {
  walletScope: string;
  updatedAt: string;
  nativeClosedVerified: boolean | null;
  allocationNoEffectVerified: boolean | null;
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

export const RECEIPT_SELECTION = {
  walletScope: akashTxAllocations.walletScope,
  updatedAt: receiptVersion,
  nativeClosedVerified: akashTxAllocations.nativeClosedVerified,
  allocationNoEffectVerified: akashTxAllocations.allocationNoEffectVerified,
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

export function allocationRecord(row: AllocationRow): AkashTxAllocationRecord {
  const metadata = DatabaseCellAllocationMetadataSchema.parse(
    row.appliedDatabaseCellBinding ?? []
  );
  return {
    ...(metadata.retentionPolicy
      ? { retentionPolicy: metadata.retentionPolicy }
      : {}),
    ...(row.appliedDatabaseCellBinding == null
      ? {}
      : { appliedDatabaseCellBinding: metadata.bindings }),
    custody: { walletScope: row.walletScope, updatedAt: row.updatedAt },
    nativeClosedVerified: row.nativeClosedVerified,
    allocationNoEffectVerified: row.allocationNoEffectVerified,
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
    ...(row.allocationCursor !== null
      ? { allocationCursor: row.allocationCursor }
      : {}),
    ...(row.externalName !== null ? { externalName: row.externalName } : {}),
    ...(row.providerAccount !== null
      ? { providerAccount: row.providerAccount }
      : {}),
    ...(row.lastAppliedSdlHash !== null
      ? { lastAppliedSdlHash: row.lastAppliedSdlHash }
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

  async claim(input: {
    cogniKey: string;
    workload: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
    retentionPolicy?: "retain";
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
  }): Promise<
    | { state: "claimed"; record: AkashTxAllocationRecord }
    | { state: "owned"; record: AkashTxAllocationRecord }
    | { state: "settled"; record: AkashTxAllocationRecord }
    | { state: "blocked"; ownerCogniKey: string }
  > {
    const db = await this.getDb();
    return receiptTransaction(db, async (tx, guarded) => {
      const [existing] = await tx
        .select(RECEIPT_SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey)
          )
        )
        .for("update")
        .limit(1);
      if (existing && existing.state === "preparing") {
        return { state: "owned" as const, record: allocationRecord(existing) };
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
        ((!guarded && existing.allocationNoEffectVerified === null) ||
          (existing.allocationNoEffectVerified === true &&
            existing.allocationCursor === null)) &&
        existing.nodeId === input.identity.nodeId &&
        existing.environment === input.environment &&
        existing.compositeUid === input.identity.compositeUid;
      if (existing && !reclaimable) {
        return {
          state: "settled" as const,
          record: allocationRecord(existing),
        };
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
            settledAt: null,
            workload: input.workload,
            compositeGeneration: sql`greatest(${akashTxAllocations.compositeGeneration}, ${input.identity.compositeGeneration}::int)`,
            updatedAt: advanceReceiptVersion,
          })
          .where(
            and(
              receiptFence(
                this.walletScope,
                input.cogniKey,
                allocationRecord(existing)
              ),
              eq(akashTxAllocations.state, "failed"),
              sql`${akashTxAllocations.externalName} is null`
            )
          )
          .returning(RECEIPT_SELECTION);
        if (!reopened) {
          throw new Error("akash_tx_allocations re-claim returned no row");
        }
        return {
          state: "claimed" as const,
          record: allocationRecord(reopened),
        };
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
          allocationNoEffectVerified: guarded ? true : null,
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
        .returning(RECEIPT_SELECTION);
      if (!inserted) {
        throw new Error("akash_tx_allocations insert returned no row");
      }
      return { state: "claimed" as const, record: allocationRecord(inserted) };
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
    | { state: "held"; record: AkashTxAllocationRecord }
    | { state: "absent" }
    | { state: "conflict"; record: AkashTxAllocationRecord }
  > {
    const db = await this.getDb();
    return receiptTransaction(db, async (tx) => {
      const [existing] = await tx
        .select(RECEIPT_SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            eq(akashTxAllocations.cogniKey, input.cogniKey)
          )
        )
        .for("update")
        .limit(1);
      if (!existing) return { state: "absent" as const };
      if (
        existing.nodeId !== input.identity.nodeId ||
        existing.environment !== input.environment ||
        existing.compositeUid !== input.identity.compositeUid
      ) {
        return {
          state: "conflict" as const,
          record: allocationRecord(existing),
        };
      }

      if (input.identity.compositeGeneration < existing.compositeGeneration)
        return {
          state: "conflict" as const,
          record: allocationRecord(existing),
        };
      const metadata = DatabaseCellAllocationMetadataSchema.parse(
        existing.appliedDatabaseCellBinding ?? []
      );
      const changed =
        input.identity.compositeGeneration > existing.compositeGeneration ||
        (input.retentionPolicy === "retain" &&
          metadata.retentionPolicy !== "retain");
      if (!changed)
        return { state: "bound" as const, record: allocationRecord(existing) };
      if (existing.state === "preparing")
        return { state: "held" as const, record: allocationRecord(existing) };
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
          updatedAt: advanceReceiptVersion,
        })
        .where(
          and(
            receiptFence(
              this.walletScope,
              input.cogniKey,
              allocationRecord(existing)
            )
          )
        )
        .returning(RECEIPT_SELECTION);
      if (!updated) {
        throw new Error("akash_tx_allocations identity bind returned no row");
      }
      return { state: "bound" as const, record: allocationRecord(updated) };
    });
  }

  private async change(
    input: {
      cogniKey: string;
      expected?: AkashTxAllocationRecord;
      deadlineAt?: number;
    },
    values: (
      record: AkashTxAllocationRecord,
      guarded: boolean,
      tx: Parameters<Parameters<Database["transaction"]>[0]>[0]
    ) =>
      | {
          [K in keyof typeof akashTxAllocations.$inferInsert]?:
            | (typeof akashTxAllocations.$inferInsert)[K]
            | SQL;
        }
      | null
      | Promise<
          | {
              [K in keyof typeof akashTxAllocations.$inferInsert]?:
                | (typeof akashTxAllocations.$inferInsert)[K]
                | SQL;
            }
          | null
        >
  ): Promise<AkashTxAllocationRecord> {
    const db = await this.getDb();
    return receiptTransaction(
      db,
      async (tx, guarded) => {
        const [row] = await tx
          .select(RECEIPT_SELECTION)
          .from(akashTxAllocations)
          .where(receiptFence(this.walletScope, input.cogniKey, input.expected))
          .for("update")
          .limit(1);
        if (!row) throw new Error("receipt custody changed");
        const record = allocationRecord(row);
        const changes = await values(record, guarded, tx);
        if (changes === null) return record;
        const [updated] = await tx
          .update(akashTxAllocations)
          .set({ ...changes, updatedAt: advanceReceiptVersion })
          .where(receiptFence(this.walletScope, input.cogniKey, input.expected))
          .returning(RECEIPT_SELECTION);
        if (!updated)
          throw new Error("receipt custody CAS returned no successor");
        return allocationRecord(updated);
      },
      input.deadlineAt
    );
  }

  async prepare(input: {
    cogniKey: string;
    allocationCursor: string;
    expected?: AkashTxAllocationRecord;
    coverage?: AkashNativeWalletInventory;
    deadlineAt?: number;
  }): Promise<AkashTxAllocationRecord> {
    return this.change(input, async (record, guarded, tx) => {
      if (!guarded && record.allocationNoEffectVerified !== null)
        throw new Error("receipt protocol changed before prepare");
      if (guarded)
        await this.checkAdmission(tx, record, input.coverage, input.deadlineAt);
      if (
        record.state !== "preparing" ||
        record.allocationCursor !== undefined ||
        record.externalName !== undefined ||
        (guarded && record.allocationNoEffectVerified !== true)
      )
        throw new Error("receipt custody does not own an unused wallet slot");
      return {
        allocationCursor: input.allocationCursor,
        ...(guarded ? { allocationNoEffectVerified: false } : {}),
      };
    });
  }

  private async checkAdmission(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    proposed: AkashTxAllocationRecord,
    coverage?: AkashNativeWalletInventory,
    deadlineAt?: number
  ) {
    if (
      !coverage ||
      !deadlineAt ||
      Date.now() >= deadlineAt ||
      coverage.owner !== this.walletScope.slice("akash-console:".length) ||
      !/^[1-9][0-9]*$/.test(coverage.height) ||
      !Number.isFinite(Date.parse(coverage.observedAt)) ||
      Date.now() - Date.parse(coverage.observedAt) > 30_000 ||
      Date.parse(coverage.observedAt) > Date.now()
    )
      throw new Error("fresh native receipt coverage required");
    const app =
      /^xcw:([^:]+):([^:]+):([1-9][0-9]*)(?::recover:([1-9][0-9]*))?$/.exec(
        proposed.cogniKey
      );
    const recovery = /^pg-recover:v1:([^:]+):([^:]+):([^:]+):[^:]+$/.exec(
      proposed.cogniKey
    );
    if (
      (!app || app[2] !== proposed.workload) &&
      (!recovery ||
        recovery[1] !== proposed.identity.nodeId ||
        recovery[2] !== proposed.environment ||
        proposed.retentionPolicy !== "retain")
    )
      throw new Error("unqualified family for native admission");
    const family = app
      ? `xcw:${app[1]}:${app[2]}:`
      : `pg-recover:v1:${recovery?.[1]}:${recovery?.[2]}:${recovery?.[3]}:`;
    const pattern = app
      ? "^xcw:[^:]+:[^:]+:[1-9][0-9]*(:recover:[1-9][0-9]*)?$"
      : "^pg-recover:v1:[^:]+:[^:]+:[^:]+:[^:]+$";
    const validKey = (key: string) =>
      key.startsWith(family) && new RegExp(pattern).test(key);
    const [blocker] = await tx.execute<{ malformed: boolean }>(
      sql`select coalesce(bool_or(left(cogni_key, length(${family})) <> ${family} or cogni_key !~ ${pattern}), false) as malformed from public.akash_tx_allocations where wallet_scope=${this.walletScope} and node_id=${proposed.identity.nodeId}::uuid and environment=${proposed.environment} and workload=${proposed.workload}`
    );
    if (blocker?.malformed)
      throw new Error("receipt family identity malformed");
    // Scope BEFORE LIMIT. Discharged history is excluded before counting the known budget.
    const rows = await tx
      .select(RECEIPT_SELECTION)
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.nodeId, proposed.identity.nodeId),
          eq(akashTxAllocations.environment, proposed.environment),
          eq(akashTxAllocations.workload, proposed.workload),
          sql`left(${akashTxAllocations.cogniKey}, length(${family})) = ${family}`,
          sql`${akashTxAllocations.allocationNoEffectVerified} is not null`,
          sql`not (${akashTxAllocations.state} = 'failed' and ${akashTxAllocations.allocationNoEffectVerified} is true and ${akashTxAllocations.allocationCursor} is null and ${akashTxAllocations.externalName} is null)`,
          sql`not (${akashTxAllocations.allocationNoEffectVerified} is false and ${akashTxAllocations.nativeClosedVerified} is true)`
        )
      )
      .limit(101);
    if (rows.length > 100) throw new Error("receipt lineage overflow");
    const targets = new Set<string>();
    const handles = coverage.targets.map((target) => target.dseq);
    if (new Set(handles).size !== handles.length)
      throw new Error("duplicate native targets");
    // Attribute ALL native targets, including unrelated/retained families, BEFORE exclusion.
    if (handles.length) {
      const owners = await tx
        .select(RECEIPT_SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            inArray(akashTxAllocations.externalName, handles)
          )
        )
        .limit(handles.length * 2 + 1);
      for (const target of coverage.targets) {
        const matches = owners.filter(
          (row) => row.externalName === target.dseq
        );
        if (matches.length !== 1 || !matches[0])
          throw new Error("native target attribution unknown");
        const owner = matches[0];
        if (
          !owner.nodeId ||
          !owner.compositeUid ||
          !owner.environment ||
          !owner.workload
        )
          throw new Error("native consumer identity unknown");
        if (
          owner.nodeId === proposed.identity.nodeId &&
          owner.environment === proposed.environment &&
          owner.workload === proposed.workload
        ) {
          if (!validKey(owner.cogniKey))
            throw new Error("native target family conflict");
          if (owner.nativeClosedVerified === true)
            throw new Error(
              "native target conflicts with terminal certificate"
            );
          targets.add(target.dseq);
        }
      }
    }
    for (const row of rows) {
      if (!validKey(row.cogniKey))
        throw new Error("receipt family identity malformed");
      if (row.id === proposed.receiptId) continue;
      // Legacy lineage stays NULL and financially owned; complete coverage discharges only LIVE capacity.
      if (row.allocationNoEffectVerified === null) continue;
      if (row.externalName) targets.add(row.externalName);
      else targets.add(`reservation:${row.id}`);
    }
    if (targets.size + 1 > 2)
      throw new Error("native live allocation bound exceeded");
    if (Date.now() >= deadlineAt)
      throw new Error("native admission deadline exceeded");
  }

  async listClosureCandidates(): Promise<readonly AkashTxAllocationRecord[]> {
    const db = await this.getDb();
    return receiptTransaction(db, async (tx, guarded) => {
      if (!guarded) return [];
      const rows = await tx
        .select(RECEIPT_SELECTION)
        .from(akashTxAllocations)
        .where(
          and(
            eq(akashTxAllocations.walletScope, this.walletScope),
            inArray(akashTxAllocations.state, ["allocated", "released"]),
            sql`${akashTxAllocations.externalName} is not null`,
            sql`${akashTxAllocations.nativeClosedVerified} is null`
          )
        )
        .orderBy(akashTxAllocations.updatedAt, akashTxAllocations.id)
        .limit(20);
      return rows.map(allocationRecord);
    });
  }

  async startClosureRead(
    expected: AkashTxAllocationRecord,
    deadlineAt: number
  ): Promise<AkashTxAllocationRecord> {
    return this.change(
      { cogniKey: expected.cogniKey, expected, deadlineAt },
      (record, guarded) => {
        if (
          !guarded ||
          !record.externalName ||
          !["allocated", "released"].includes(record.state) ||
          record.nativeClosedVerified !== null
        )
          throw new Error("receipt qualification held");
        return {}; // Rotate ONLY at actual read start. This neither certifies nor settles.
      }
    );
  }

  async certifyNativeClosed(input: {
    expected: AkashTxAllocationRecord;
    owner: string;
    dseq: string;
    closed: boolean;
    deadlineAt: number;
  }): Promise<AkashTxAllocationRecord> {
    return this.change(
      {
        cogniKey: input.expected.cogniKey,
        expected: input.expected,
        deadlineAt: input.deadlineAt,
      },
      (record, guarded) => {
        if (
          !guarded ||
          Date.now() >= input.deadlineAt ||
          !input.closed ||
          input.owner !== this.walletScope.slice("akash-console:".length) ||
          input.dseq !== record.externalName ||
          !["allocated", "released"].includes(record.state)
        )
          throw new Error("native own-handle certificate refused");
        if (record.nativeClosedVerified === true) return null;
        return { nativeClosedVerified: true };
      }
    );
  }

  async recordAllocation(input: {
    cogniKey: string;
    externalName: string;
    providerAccount?: string;
    expected?: AkashTxAllocationRecord;
  }): Promise<AkashTxAllocationRecord> {
    return this.change(input, (record) => {
      if (
        !input.externalName ||
        (record.externalName && record.externalName !== input.externalName)
      )
        throw new Error("receipt handle conflict");
      if (
        record.providerAccount &&
        input.providerAccount &&
        record.providerAccount !== input.providerAccount
      )
        throw new Error("receipt provider conflict");
      if (record.state !== "preparing" && record.state !== "allocated")
        throw new Error("receipt custody has no live wallet slot");
      if (record.allocationNoEffectVerified === true)
        throw new Error("unused receipt must prepare before binding");
      if (
        record.state === "allocated" &&
        record.externalName === input.externalName &&
        (!input.providerAccount ||
          record.providerAccount === input.providerAccount)
      )
        return null;
      return {
        state: "allocated",
        externalName: input.externalName,
        ...(input.providerAccount
          ? { providerAccount: input.providerAccount }
          : {}),
        settledAt: sql`coalesce(${akashTxAllocations.settledAt}, clock_timestamp())`,
      };
    });
  }

  async recordAppliedSdlHash(input: {
    cogniKey: string;
    sdlHash: string;
    expected?: AkashTxAllocationRecord;
  }): Promise<AkashTxAllocationRecord> {
    return this.change(input, (record) => {
      if (record.state === "preparing")
        throw new Error("preparing receipt metadata held");
      if (record.lastAppliedSdlHash === input.sdlHash) return null;
      return { lastAppliedSdlHash: input.sdlHash };
    });
  }

  async listStalePreparing(input: {
    olderThanMs: number;
    limit: number;
  }): Promise<readonly AkashTxStaleAllocation[]> {
    const db = await this.getDb();
    const rows = await db
      .select({
        ...RECEIPT_SELECTION,
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
      record: allocationRecord(row),
      cogniKey: row.cogniKey,
      ...(row.allocationCursor
        ? { allocationCursor: row.allocationCursor }
        : {}),
      heldForMs: Number(row.heldForMs),
    }));
  }

  async fail(input: {
    cogniKey: string;
    failureCode: string;
    expected?: AkashTxAllocationRecord;
  }): Promise<AkashTxAllocationRecord> {
    return this.change(input, (record, guarded) => {
      if (
        record.state !== "preparing" ||
        record.externalName ||
        (guarded &&
          (record.allocationNoEffectVerified !== true ||
            record.allocationCursor))
      )
        throw new Error("receipt custody cannot be discharged");
      return {
        state: "failed",
        failureCode: input.failureCode,
        settledAt: sql`clock_timestamp()`,
      };
    });
  }

  async markReleased(input: {
    cogniKey: string;
    expected?: AkashTxAllocationRecord;
  }): Promise<AkashTxAllocationRecord> {
    return this.change(input, (record) => {
      if (record.state !== "allocated" && record.state !== "released")
        throw new Error("receipt custody is not allocated");
      if (record.state === "released") return null;
      return {
        state: "released",
        settledAt: sql`coalesce(${akashTxAllocations.settledAt}, clock_timestamp())`,
      };
    });
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
      .select(RECEIPT_SELECTION)
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
    return rows.map(allocationRecord);
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
      .select(RECEIPT_SELECTION)
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
    return rows.map(allocationRecord);
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
      .select(RECEIPT_SELECTION)
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
    return rows.map(allocationRecord);
  }

  async read(input: {
    cogniKey: string;
  }): Promise<AkashTxAllocationRecord | null> {
    const db = await this.getDb();
    const [row] = await db
      .select(RECEIPT_SELECTION)
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.cogniKey, input.cogniKey)
        )
      )
      .limit(1);
    return row ? allocationRecord(row) : null;
  }
}
