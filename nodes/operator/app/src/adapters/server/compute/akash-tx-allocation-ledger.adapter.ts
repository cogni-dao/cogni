// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-tx-allocation-ledger.adapter`
 * Purpose: Durable custody of "we may have paid" — the Postgres implementation of the Akash
 *   allocation ledger behind the transaction actuator (task.5095). Holds the wallet-wide
 *   create slot and the pre-transaction cursor that makes a lost Console response recoverable.
 * Scope: Reads/writes akash_tx_allocations. Contains no provider IO, no recovery policy, and
 *   no reconciliation — the actuator decides, the database enforces.
 * Invariants:
 *   - WALLET_SINGLE_WRITER: at most one row per wallet scope may be `preparing`. Enforced by
 *     the partial unique index, not by an in-process lock a crash can drop.
 *   - HANDLE_IS_WRITE_ONCE: external_name is set with COALESCE — a recorded paid handle can
 *     never be overwritten by a later attempt under the same key.
 *   - PREPARE_REQUIRES_OWNERSHIP: writing the cursor fails when the key does not hold a
 *     `preparing` slot, so a resumed zombie can never proceed to spend.
 *   - NO_TIME_BASED_RELEASE: nothing here releases a slot on a timer. An unresolved
 *     allocation stays held and loudly blocks, because releasing without evidence is how you
 *     pay twice (bug.5115 is fixed by key-addressable resolution, not by expiry).
 * Side-effects: IO (Postgres via the injected app-role Drizzle client)
 * Links: @ports/akash-tx.port, features/compute/akash-tx/akash-tx-actuator.ts,
 *   features/compute/akash-tx/akash-tx-wallet.ts (resolves the wallet scope this serializes),
 *   @shared/db/akash-tx-allocations (operator-local table, NOT @cogni/db-schema), task.5095
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { and, eq, sql } from "drizzle-orm";

import type {
  AkashTxAllocationLedgerPort,
  AkashTxAllocationRecord,
  AkashTxAllocationState,
} from "@/ports";
import { akashTxAllocations } from "@/shared/db/schema";

interface AllocationRow {
  cogniKey: string;
  state: string;
  allocationCursor: string | null;
  externalName: string | null;
  providerAccount: string | null;
}

const SELECTION = {
  cogniKey: akashTxAllocations.cogniKey,
  state: akashTxAllocations.state,
  allocationCursor: akashTxAllocations.allocationCursor,
  externalName: akashTxAllocations.externalName,
  providerAccount: akashTxAllocations.providerAccount,
};

function toRecord(row: AllocationRow): AkashTxAllocationRecord {
  return {
    cogniKey: row.cogniKey,
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
      if (existing) {
        return existing.state === "preparing"
          ? { state: "owned" as const, record: toRecord(existing) }
          : { state: "settled" as const, record: toRecord(existing) };
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

      const [inserted] = await tx
        .insert(akashTxAllocations)
        .values({
          walletScope: this.walletScope,
          cogniKey: input.cogniKey,
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
