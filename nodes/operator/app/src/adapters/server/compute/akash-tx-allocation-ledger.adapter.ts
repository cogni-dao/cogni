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
import { and, eq, sql } from "drizzle-orm";

import type {
  AkashTxAllocationLedgerPort,
  AkashTxAllocationRecord,
  AkashTxAllocationState,
  AkashTxStaleAllocation,
  AkashTxWorkloadIdentity,
} from "@/ports";
import { akashTxAllocations } from "@/shared/db/schema";

interface AllocationRow {
  id: string;
  cogniKey: string;
  nodeId: string;
  compositeUid: string;
  compositeGeneration: number;
  environment: string;
  state: string;
  allocationCursor: string | null;
  externalName: string | null;
  providerAccount: string | null;
}

const SELECTION = {
  id: akashTxAllocations.id,
  cogniKey: akashTxAllocations.cogniKey,
  nodeId: akashTxAllocations.nodeId,
  compositeUid: akashTxAllocations.compositeUid,
  compositeGeneration: akashTxAllocations.compositeGeneration,
  environment: akashTxAllocations.environment,
  state: akashTxAllocations.state,
  allocationCursor: akashTxAllocations.allocationCursor,
  externalName: akashTxAllocations.externalName,
  providerAccount: akashTxAllocations.providerAccount,
};

function toRecord(row: AllocationRow): AkashTxAllocationRecord {
  return {
    receiptId: row.id,
    cogniKey: row.cogniKey,
    identity: {
      nodeId: row.nodeId,
      compositeUid: row.compositeUid,
      compositeGeneration: row.compositeGeneration,
    },
    environment: row.environment,
    state: row.state as AkashTxAllocationState,
    ...(row.allocationCursor ? { allocationCursor: row.allocationCursor } : {}),
    ...(row.externalName ? { externalName: row.externalName } : {}),
    ...(row.providerAccount ? { providerAccount: row.providerAccount } : {}),
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
  }): Promise<
    | { state: "claimed"; record: AkashTxAllocationRecord }
    | { state: "owned"; record: AkashTxAllocationRecord }
    | { state: "settled"; record: AkashTxAllocationRecord }
    | { state: "blocked"; ownerCogniKey: string }
  > {
    const db = await this.getDb();
    return db.transaction(async (tx) => {
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
      if (existing && existing.state === "preparing") {
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
            // The previous attempt's baseline described a transaction that is now settled.
            // Carrying it forward would point the next recovery scan at the wrong high-water
            // mark and make an unrelated later deployment look adoptable.
            allocationCursor: null,
            failureCode: null,
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
  }): Promise<
    | { state: "bound"; record: AkashTxAllocationRecord }
    | { state: "absent" }
    | { state: "conflict"; record: AkashTxAllocationRecord }
  > {
    const db = await this.getDb();
    return db.transaction(async (tx) => {
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
  }): Promise<void> {
    const db = await this.getDb();
    const updated = await db
      .update(akashTxAllocations)
      .set({
        allocationCursor: input.allocationCursor,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.cogniKey, input.cogniKey),
          eq(akashTxAllocations.state, "preparing")
        )
      )
      .returning({ cogniKey: akashTxAllocations.cogniKey });
    if (updated.length === 0) {
      throw new Error(
        "cannot record a pre-transaction cursor without owning the wallet slot"
      );
    }
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
          sql`${akashTxAllocations.externalName} is null`
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
