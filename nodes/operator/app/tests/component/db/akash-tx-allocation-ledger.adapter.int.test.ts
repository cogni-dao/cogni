// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/akash-tx-allocation-ledger.adapter.int`
 * Purpose: Prove the Akash allocation ledger's invariants against a REAL Postgres — the
 *   wallet-wide single-writer index and the write-once handle are database guarantees, not
 *   adapter politeness, and a unit test with a fake could never establish that (task.5095).
 * Scope: DrizzleAkashTxAllocationLedger over akash_tx_allocations via testcontainers. Does
 *   NOT touch the Akash Console, a wallet, or any provider.
 * Invariants: WALLET_SINGLE_WRITER, HANDLE_IS_WRITE_ONCE, PREPARE_REQUIRES_OWNERSHIP,
 *   IDENTITY_BEFORE_TRANSACTION, IDENTITY_IS_WRITE_ONCE,
 *   SETTLED_WITHOUT_A_HANDLE_IS_RETRYABLE, NO_TIME_BASED_RELEASE (bug.5192).
 * Side-effects: IO (Postgres via testcontainers)
 * Links: src/adapters/server/compute/akash-tx-allocation-ledger.adapter.ts, task.5095,
 *   task.5103, bug.5192
 * @internal
 */

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { akashTxAllocations } from "@/shared/db/schema";

/**
 * An ACCOUNT-keyed scope, because `akash_tx_allocations_wallet_scope_account_check` (bug.5187)
 * now rejects anything that is not `akash-console:` + a bech32 Akash address. A fixture that
 * could not exist in production is not a fixture.
 */
const WALLET = "akash-console:akash1testwalletaddressforcomponenttests0000";
const NODE_ID = "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60";
const OTHER_NODE_ID = "9a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const IDENTITY = {
  nodeId: NODE_ID,
  compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
  compositeGeneration: 3,
};

describe("DrizzleAkashTxAllocationLedger (Component)", () => {
  const db = getSeedDb();
  const ledger = new DrizzleAkashTxAllocationLedger(async () => db, WALLET);

  beforeEach(async () => {
    await db
      .delete(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET));
  });

  it("claims the wallet slot once and blocks every other key until it settles", async () => {
    const first = await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    expect(first.state).toBe("claimed");

    const second = await ledger.claim({
      cogniKey: "k2",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    expect(second).toMatchObject({ state: "blocked", ownerCogniKey: "k1" });

    // Same key re-entering owns its own slot — that is how a retry resumes.
    const reentry = await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    expect(reentry.state).toBe("owned");

    await ledger.recordAllocation({ cogniKey: "k1", externalName: "7001" });

    const afterSettle = await ledger.claim({
      cogniKey: "k2",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    expect(afterSettle.state).toBe("claimed");
  });

  it("enforces the single-writer rule in the database itself", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    // Bypass the adapter's read-then-insert and go straight at the constraint.
    await expect(
      db.insert(akashTxAllocations).values({
        walletScope: WALLET,
        cogniKey: "k2",
        nodeId: NODE_ID,
        compositeUid: IDENTITY.compositeUid,
        compositeGeneration: IDENTITY.compositeGeneration,
        workload: "toks9",
        environment: "candidate-a",
        state: "preparing",
      })
    ).rejects.toThrow();
  });

  it("keeps the pre-transaction cursor durable and refuses a cursor without ownership", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await ledger.prepare({ cogniKey: "k1", allocationCursor: "7000" });
    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      state: "preparing",
      allocationCursor: "7000",
    });

    await expect(
      ledger.prepare({ cogniKey: "ghost", allocationCursor: "7000" })
    ).rejects.toThrow(/wallet slot/);

    await ledger.recordAllocation({ cogniKey: "k1", externalName: "7001" });
    await expect(
      ledger.prepare({ cogniKey: "k1", allocationCursor: "7999" })
    ).rejects.toThrow(/wallet slot/);
  });

  it("never overwrites a recorded paid handle", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await ledger.prepare({ cogniKey: "k1", allocationCursor: "7000" });
    await ledger.recordAllocation({ cogniKey: "k1", externalName: "7001" });
    await ledger.recordAllocation({
      cogniKey: "k1",
      externalName: "9999",
      providerAccount: "akash1provider",
    });

    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      state: "allocated",
      externalName: "7001",
      providerAccount: "akash1provider",
    });
  });

  it("settles a released key and refuses to fail one that already has a handle", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await ledger.prepare({ cogniKey: "k1", allocationCursor: "7000" });
    await ledger.recordAllocation({ cogniKey: "k1", externalName: "7001" });

    await ledger.fail({ cogniKey: "k1", failureCode: "provider_rejected" });
    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      state: "allocated",
      externalName: "7001",
    });

    await ledger.markReleased({ cogniKey: "k1" });
    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      state: "released",
    });
  });

  it("fails a key that never reached a transaction, releasing the wallet", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await ledger.fail({ cogniKey: "k1", failureCode: "provider_rejected" });
    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      state: "failed",
    });
    const next = await ledger.claim({
      cogniKey: "k2",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    expect(next.state).toBe("claimed");
  });

  it("re-claims a receipt settled WITHOUT a handle, under the same key", async () => {
    // bug.5192: `failed` + `external_name IS NULL` is only ever written with proof that
    // nothing is billing, so there is no spend to double-pay. Before this, the only escape
    // from a crashed create was a human bumping `lease_epoch` in the catalog.
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await ledger.prepare({ cogniKey: "k1", allocationCursor: "7000" });
    await ledger.fail({
      cogniKey: "k1",
      failureCode: "allocation_rolled_back",
    });

    const again = await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });

    expect(again.state).toBe("claimed");
    const row = await ledger.read({ cogniKey: "k1" });
    expect(row).toMatchObject({ state: "preparing" });
    // The stale baseline MUST be cleared: reusing it would point the next recovery scan at a
    // high-water mark that predates a settled transaction.
    expect(row?.allocationCursor).toBeUndefined();
    // …and it is a real slot: the wallet is serialized behind it again.
    const other = await ledger.claim({
      cogniKey: "k2",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    expect(other).toMatchObject({ state: "blocked", ownerCogniKey: "k1" });
  });

  it("never re-claims a receipt that bound a handle, however it was settled", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await ledger.prepare({ cogniKey: "k1", allocationCursor: "7000" });
    await ledger.recordAllocation({ cogniKey: "k1", externalName: "7001" });
    await ledger.markReleased({ cogniKey: "k1" });

    expect(
      await ledger.claim({
        cogniKey: "k1",
        workload: "toks9",
        environment: "candidate-a",
        identity: IDENTITY,
      })
    ).toMatchObject({ state: "settled", record: { externalName: "7001" } });
  });

  it("refuses to re-claim a settled receipt for a DIFFERENT node", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await ledger.fail({
      cogniKey: "k1",
      failureCode: "allocation_rolled_back",
    });

    // Re-opening under another identity would move spend attribution; it stays `settled` so
    // the actuator raises identity_conflict instead.
    const hijack = await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: { ...IDENTITY, nodeId: OTHER_NODE_ID },
    });
    expect(hijack).toMatchObject({
      state: "settled",
      record: { identity: { nodeId: NODE_ID } },
    });
  });

  it("lists only aged, handle-less `preparing` receipts as stale", async () => {
    await ledger.claim({
      cogniKey: "k-fresh",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });

    // Nothing is stale yet: age is measured by POSTGRES, not by the caller's clock.
    expect(
      await ledger.listStalePreparing({ olderThanMs: 1000, limit: 10 })
    ).toEqual([]);

    await db
      .update(akashTxAllocations)
      .set({ updatedAt: sql`now() - interval '2 hours'` })
      .where(eq(akashTxAllocations.cogniKey, "k-fresh"));

    const stale = await ledger.listStalePreparing({
      olderThanMs: 900_000,
      limit: 10,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.cogniKey).toBe("k-fresh");
    expect(stale[0]?.heldForMs).toBeGreaterThan(900_000);

    // A recorded handle takes the row out of scope entirely — it is not stuck, it is paid.
    await ledger.recordAllocation({
      cogniKey: "k-fresh",
      externalName: "7001",
    });
    expect(
      await ledger.listStalePreparing({ olderThanMs: 900_000, limit: 10 })
    ).toEqual([]);
  });

  it("binds node identity in the very row that opens the wallet slot", async () => {
    // IDENTITY_BEFORE_TRANSACTION — the claim IS the receipt. Nothing later can add identity
    // to a lease that was already paid for; the NOT NULL columns make that unreachable.
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });

    const [row] = await db
      .select()
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.cogniKey, "k1"));
    expect(row).toMatchObject({
      nodeId: NODE_ID,
      compositeUid: IDENTITY.compositeUid,
      compositeGeneration: 3,
      environment: "candidate-a",
      state: "preparing",
      allocationCursor: null,
    });
    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      identity: IDENTITY,
      environment: "candidate-a",
    });
  });

  it("refuses a receipt with no node identity at the database level", async () => {
    await expect(
      db.execute(
        sql`insert into akash_tx_allocations (wallet_scope, cogni_key, workload, environment, state)
            values (${WALLET}, 'anonymous', 'toks9', 'candidate-a', 'preparing')`
      )
    ).rejects.toThrow();
  });

  it("re-binds a receipt for an update, advancing the generation but never the owner", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await ledger.prepare({ cogniKey: "k1", allocationCursor: "7000" });
    await ledger.recordAllocation({ cogniKey: "k1", externalName: "7001" });

    const bound = await ledger.bindIdentity({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: { ...IDENTITY, compositeGeneration: 9 },
    });
    expect(bound).toMatchObject({ state: "bound" });

    // Monotonic: a delayed retry carrying an older revision cannot walk the receipt backwards.
    await ledger.bindIdentity({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: { ...IDENTITY, compositeGeneration: 2 },
    });
    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      identity: { nodeId: NODE_ID, compositeGeneration: 9 },
      state: "allocated",
      externalName: "7001",
    });
  });

  it("reports a conflict instead of re-pointing a receipt at another immutable identity", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });

    expect(
      await ledger.bindIdentity({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: { ...IDENTITY, nodeId: OTHER_NODE_ID },
      })
    ).toMatchObject({ state: "conflict" });
    expect(
      await ledger.bindIdentity({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: {
          ...IDENTITY,
          compositeUid: "1aa11111-2222-4333-8444-555555555555",
        },
      })
    ).toMatchObject({ state: "conflict" });
    expect(
      await ledger.bindIdentity({
        cogniKey: "k1",
        environment: "production",
        identity: IDENTITY,
      })
    ).toMatchObject({ state: "conflict" });
    expect(
      await ledger.bindIdentity({
        cogniKey: "ghost",
        environment: "candidate-a",
        identity: IDENTITY,
      })
    ).toMatchObject({ state: "absent" });

    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      identity: IDENTITY,
      environment: "candidate-a",
    });
  });
});
