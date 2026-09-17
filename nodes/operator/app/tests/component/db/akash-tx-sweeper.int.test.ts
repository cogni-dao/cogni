// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/akash-tx-sweeper.int`
 * Purpose: Execution proof for the bug.5192 reaper against a REAL Postgres — wedge a receipt, run the sweeper, assert the wallet slot frees itself with ZERO human writes. The unit suite proves the sweeper's branching over a fake ledger; only a real database proves the wedge actually clears the single-writer index that froze the account for 33h.
 * Scope: AkashTxActuator.sweepStaleAllocations over the real DrizzleAkashTxAllocationLedger via testcontainers, with a stub Console. Does NOT contact the Akash Console, a wallet, a provider, or spend anything.
 * Invariants: SWEEP_RECOVERS_WITHOUT_HUMAN_WRITES, CLOSE_VERIFY_THEN_CLEAR, NO_TIME_BASED_RELEASE
 * Side-effects: IO (Postgres via testcontainers)
 * Links: task.5136, bug.5192, knowledge:akash-promotion-north-star,
 *   src/features/compute/akash-tx/akash-tx-actuator.ts
 * @internal
 */

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { AkashTxActuator } from "@/features/compute/akash-tx/akash-tx-actuator";
import type {
  AkashAllocationProbe,
  AkashTxConsolePort,
  ProvisionOutput,
} from "@/ports";
import { akashTxAllocations } from "@/shared/db/schema";

const WALLET = "akash-console:akash1sweeperaddressforcomponenttests00000";
const IDENTITY = {
  nodeId: "3c7a9b21-5d8e-4f10-a2b3-6c7d8e9f0a1b",
  compositeUid: "7b6a5c4d-3e2f-4109-8a7b-6c5d4e3f2a10",
  compositeGeneration: 1,
};

/** Console stub. Every method throws unless a test opts into it — no accidental IO shape. */
function consoleStub(probe: AkashAllocationProbe): AkashTxConsolePort {
  return {
    allocationCursor: async () => "cursor-0",
    allocateAndLease: async () => {
      throw new Error("the sweeper must never open a paid transaction");
    },
    findAllocationSince: async () => probe,
    status: async () => {
      throw new Error("unexpected status()");
    },
    updateAllocated: async () => {
      throw new Error("unexpected updateAllocated()");
    },
    release: async () => {
      throw new Error("unexpected release()");
    },
  };
}

const NOOP = { info: () => {}, warn: () => {}, error: () => {} };
const COSTS = {
  costEvidence: {
    observeCost: async () => {
      throw new Error("unexpected observeCost()");
    },
  },
  costStore: {
    bind: async () => {},
    observe: async () => {},
    close: async () => {},
    reportByNode: async () => [],
  },
  providerConsumerAccountId: "akash1sweeperaddressforcomponenttests00000",
};

describe("AkashTxActuator.sweepStaleAllocations (Component, real Postgres)", () => {
  const db = getSeedDb();
  const ledger = new DrizzleAkashTxAllocationLedger(async () => db, WALLET);

  const build = (probe: AkashAllocationProbe) =>
    new AkashTxActuator({
      console: consoleStub(probe),
      ledger,
      log: NOOP,
      ...COSTS,
    });

  /** Age the row in POSTGRES, never the caller's clock — NO_TIME_BASED_RELEASE. */
  const age = (cogniKey: string) =>
    db
      .update(akashTxAllocations)
      .set({ updatedAt: sql`now() - interval '2 hours'` })
      .where(eq(akashTxAllocations.cogniKey, cogniKey));

  beforeEach(async () => {
    await db
      .delete(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET));
  });

  it("frees a wallet wedged by a crashed create, with zero human writes", async () => {
    // THE 33h OUTAGE, REPRODUCED. A create claimed the wallet-wide slot and died before the
    // Console POST — so the receipt is `preparing` with NO cursor.
    await ledger.claim({
      cogniKey: "wedged",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });

    // BEFORE: the account is frozen. Every other key is blocked by the single-writer index
    // in the DATABASE — this is the exact condition toks5 sat in, and it has no exit.
    expect(
      await ledger.claim({
        cogniKey: "someone-else",
        workload: "toks8",
        environment: "candidate-a",
        identity: IDENTITY,
      })
    ).toMatchObject({ state: "blocked", ownerCogniKey: "wedged" });

    await age("wedged");

    // The sweeper runs on its own. No operator, no SQL, no Console write.
    const report = await build({ outcome: "settled" }).sweepStaleAllocations({
      olderThanMs: 900_000,
      limit: 10,
    });
    expect(report).toMatchObject({
      scanned: 1,
      rolledBack: 1,
      adopted: 0,
      held: 0,
    });

    // AFTER: the slot is free and the fleet deploys again.
    expect(
      (
        await ledger.claim({
          cogniKey: "someone-else",
          workload: "toks8",
          environment: "candidate-a",
          identity: IDENTITY,
        })
      ).state
    ).toBe("claimed");
  });

  it("re-claims the SAME key after the sweep — no lease-generation bump needed", async () => {
    // What made toks5 need a hand-written #2282 counter bump: a settled, handle-less receipt
    // was permanently un-re-claimable. It must now be retryable under the identical key.
    await ledger.claim({
      cogniKey: "same-key",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await age("same-key");
    await build({ outcome: "settled" }).sweepStaleAllocations({
      olderThanMs: 900_000,
      limit: 10,
    });

    const again = await ledger.claim({
      cogniKey: "same-key",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    expect(again.state).toBe("claimed");
    // …and the stale baseline is gone, so the next recovery scan cannot read a high-water
    // mark that predates a settled transaction.
    expect(
      (await ledger.read({ cogniKey: "same-key" }))?.allocationCursor
    ).toBeUndefined();
  });

  it("HOLDS a receipt whose wallet is ambiguous — fail-closed still means never spend blind", async () => {
    // The half that must NOT become recoverable. Several live allocations past the baseline is
    // undecidable; clearing the slot could orphan a lease that is still billing.
    await ledger.claim({
      cogniKey: "ambiguous",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await db
      .update(akashTxAllocations)
      .set({ allocationCursor: "cursor-0" })
      .where(eq(akashTxAllocations.cogniKey, "ambiguous"));
    await age("ambiguous");

    const report = await build({
      outcome: "ambiguous",
      dseqs: ["7001", "7002"],
    }).sweepStaleAllocations({ olderThanMs: 900_000, limit: 10 });

    expect(report).toMatchObject({ scanned: 1, rolledBack: 0, held: 1 });
    const [row] = await db
      .select()
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.cogniKey, "ambiguous"));
    expect(row?.state).toBe("preparing");
  });

  it("ADOPTS a receipt whose lease is live — never rolls back something that is billing", async () => {
    await ledger.claim({
      cogniKey: "adopted",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    await db
      .update(akashTxAllocations)
      .set({ allocationCursor: "cursor-0" })
      .where(eq(akashTxAllocations.cogniKey, "adopted"));
    await age("adopted");

    const live: ProvisionOutput = {
      externalName: "7001",
      state: "active",
      endpoints: [],
      providerAccount: "akash1provider",
    } as ProvisionOutput;

    const report = await build({
      outcome: "adopted",
      output: live,
    }).sweepStaleAllocations({ olderThanMs: 900_000, limit: 10 });

    expect(report).toMatchObject({ scanned: 1, adopted: 1, rolledBack: 0 });
    const [row] = await db
      .select()
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.cogniKey, "adopted"));
    expect(row?.externalName).toBe("7001");
  });

  it("ignores a receipt that is merely young — age is measured by Postgres", async () => {
    await ledger.claim({
      cogniKey: "young",
      workload: "toks9",
      environment: "candidate-a",
      identity: IDENTITY,
    });
    const report = await build({ outcome: "settled" }).sweepStaleAllocations({
      olderThanMs: 900_000,
      limit: 10,
    });
    expect(report).toMatchObject({ scanned: 0, rolledBack: 0 });
  });
});
