// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/akash-tx-allocation-ledger.adapter.int`
 * Purpose: Prove the Akash allocation ledger's invariants against a REAL Postgres — the
 *   wallet-wide single-writer index and the write-once handle are database guarantees, not
 *   adapter politeness, and a unit test with a fake could never establish that (task.5095).
 * Scope: DrizzleAkashTxAllocationLedger over akash_tx_allocations via testcontainers. Does
 *   NOT touch the Akash Console, a wallet, or any provider.
 * Invariants: WALLET_SINGLE_WRITER, HANDLE_IS_WRITE_ONCE, PREPARE_REQUIRES_OWNERSHIP.
 * Side-effects: IO (Postgres via testcontainers)
 * Links: src/adapters/server/compute/akash-tx-allocation-ledger.adapter.ts, task.5095
 * @internal
 */

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { akashTxAllocations } from "@/shared/db/schema";

const WALLET = "test-wallet";

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
    });
    expect(first.state).toBe("claimed");

    const second = await ledger.claim({
      cogniKey: "k2",
      workload: "toks9",
      environment: "candidate-a",
    });
    expect(second).toMatchObject({ state: "blocked", ownerCogniKey: "k1" });

    // Same key re-entering owns its own slot — that is how a retry resumes.
    const reentry = await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
    });
    expect(reentry.state).toBe("owned");

    await ledger.recordAllocation({ cogniKey: "k1", externalName: "7001" });

    const afterSettle = await ledger.claim({
      cogniKey: "k2",
      workload: "toks9",
      environment: "candidate-a",
    });
    expect(afterSettle.state).toBe("claimed");
  });

  it("enforces the single-writer rule in the database itself", async () => {
    await ledger.claim({
      cogniKey: "k1",
      workload: "toks9",
      environment: "candidate-a",
    });
    // Bypass the adapter's read-then-insert and go straight at the constraint.
    await expect(
      db.insert(akashTxAllocations).values({
        walletScope: WALLET,
        cogniKey: "k2",
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
    });
    await ledger.fail({ cogniKey: "k1", failureCode: "provider_rejected" });
    expect(await ledger.read({ cogniKey: "k1" })).toMatchObject({
      state: "failed",
    });
    const next = await ledger.claim({
      cogniKey: "k2",
      workload: "toks9",
      environment: "candidate-a",
    });
    expect(next.state).toBe("claimed");
  });
});
