// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres proof for receipt-linked compute cost attribution (task.5071). */
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { DrizzleComputeCostStore } from "@/adapters/server/compute/compute-cost-store.adapter";
import type { ComputeResourceCostEvidence } from "@/ports";
import { akashTxAllocations, computeCostIntervals } from "@/shared/db/schema";

const WALLET = "cost-test-wallet";
const NODE_ID = "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60";
const OTHER_NODE_ID = "3f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b61";
const IDENTITY = {
  nodeId: NODE_ID,
  compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
  compositeGeneration: 3,
};

function evidence(
  over: Partial<ComputeResourceCostEvidence> = {}
): ComputeResourceCostEvidence {
  return {
    computeProvider: "akash",
    resourceId: "7001",
    providerConsumerAccountId: "akash1consumer",
    providerSupplierAccountId: "akash1provider",
    rate: { amount: "7.5", denom: "uakt", unit: "block" },
    providerOpenedAtPosition: "100",
    escrow: {
      state: "open",
      funds: [{ amount: "500000", denom: "uakt" }],
      transferred: [{ amount: "10.25", denom: "uakt" }],
    },
    observedAt: new Date("2026-09-15T00:00:00.000Z"),
    ...over,
  };
}

function resource(
  resourceId: string,
  providerConsumerAccountId = "akash1consumer"
) {
  return { computeProvider: "akash", providerConsumerAccountId, resourceId };
}

describe("DrizzleComputeCostStore (Component)", () => {
  const db = getSeedDb();
  const ledger = new DrizzleAkashTxAllocationLedger(async () => db, WALLET);
  const store = new DrizzleComputeCostStore(async () => db);

  beforeEach(async () => {
    await db.delete(computeCostIntervals);
    await db
      .delete(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET));
  });

  async function allocated(
    cogniKey = "k1",
    externalName = "7001",
    nodeId = NODE_ID
  ) {
    const claim = await ledger.claim({
      cogniKey,
      workload: "toks9",
      environment: "candidate-a",
      identity: { ...IDENTITY, nodeId },
    });
    if (claim.state !== "claimed") throw new Error("expected a fresh claim");
    await ledger.recordAllocation({
      cogniKey,
      externalName,
      providerAccount: "akash1provider",
    });
    return claim.record.receiptId;
  }

  it("binds cost only to the handle already stored on the authoritative receipt", async () => {
    const allocationReceiptId = await allocated();
    await expect(
      store.bind({
        allocationReceiptId,
        resource: resource("7999"),
      })
    ).rejects.toThrow(/durable allocation receipt/);

    await store.bind({
      allocationReceiptId,
      resource: resource("7001"),
    });
    const [row] = await db.select().from(computeCostIntervals);
    expect(row).toMatchObject({
      allocationReceiptId,
      state: "allocated",
      computeProvider: "akash",
      providerConsumerAccountId: "akash1consumer",
      resourceId: "7001",
    });
  });

  it("keeps native evidence monotonic and reports exact totals by node_id", async () => {
    const allocationReceiptId = await allocated();
    await store.bind({
      allocationReceiptId,
      resource: resource("7001"),
    });
    await store.observe({ allocationReceiptId, evidence: evidence() });
    await store.observe({
      allocationReceiptId,
      evidence: evidence({
        observedAt: new Date("2026-09-15T00:01:00.000Z"),
        escrow: {
          state: "open",
          funds: [{ amount: "500000", denom: "uakt" }],
          transferred: [{ amount: "11.75", denom: "uakt" }],
        },
      }),
    });
    const secondReceiptId = await allocated("k2", "7002");
    await store.bind({
      allocationReceiptId: secondReceiptId,
      resource: resource("7002"),
    });
    await store.observe({
      allocationReceiptId: secondReceiptId,
      evidence: evidence({
        resourceId: "7002",
        rate: { amount: "2.5", denom: "uakt", unit: "block" },
        escrow: {
          state: "open",
          funds: [{ amount: "500000", denom: "uakt" }],
          transferred: [{ amount: "3.25", denom: "uakt" }],
        },
      }),
    });

    await expect(store.reportByNode()).resolves.toEqual([
      {
        nodeId: NODE_ID,
        allocatedIntervals: 0,
        activeIntervals: 2,
        closedIntervals: 0,
        transferred: [{ amount: "15", denom: "uakt" }],
        activeRates: [{ amount: "10", denom: "uakt", unit: "block" }],
      },
    ]);

    await expect(
      store.observe({
        allocationReceiptId,
        evidence: evidence({
          observedAt: new Date("2026-09-15T00:02:00.000Z"),
          escrow: {
            state: "open",
            funds: [{ amount: "500000", denom: "uakt" }],
            transferred: [{ amount: "11.5", denom: "uakt" }],
          },
        }),
      })
    ).rejects.toThrow(/regressed/);
  });

  it("filters authorized node ids in SQL before returning cost evidence", async () => {
    const firstReceiptId = await allocated("node-a", "7101", NODE_ID);
    await store.bind({
      allocationReceiptId: firstReceiptId,
      resource: resource("7101"),
    });
    await store.observe({
      allocationReceiptId: firstReceiptId,
      evidence: evidence({ resourceId: "7101" }),
    });

    const secondReceiptId = await allocated("node-b", "7102", OTHER_NODE_ID);
    await store.bind({
      allocationReceiptId: secondReceiptId,
      resource: resource("7102"),
    });
    await store.observe({
      allocationReceiptId: secondReceiptId,
      evidence: evidence({ resourceId: "7102" }),
    });

    const reports = await store.reportByNodeIds([NODE_ID]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.nodeId).toBe(NODE_ID);
    expect(reports.some((report) => report.nodeId === OTHER_NODE_ID)).toBe(
      false
    );
    await expect(store.reportByNodeIds([])).resolves.toEqual([]);
  });

  it("ignores older evidence, rejects divergent evidence at the same position, and stays closed", async () => {
    const allocationReceiptId = await allocated();
    await store.bind({
      allocationReceiptId,
      resource: resource("7001"),
    });
    const current = evidence({
      observedAt: new Date("2026-09-15T00:02:00.000Z"),
      escrow: {
        state: "open",
        funds: [{ amount: "500000", denom: "uakt" }],
        transferred: [{ amount: "20", denom: "uakt" }],
      },
    });
    await store.observe({ allocationReceiptId, evidence: current });
    await expect(
      store.observe({
        allocationReceiptId,
        evidence: evidence({
          observedAt: new Date("2026-09-15T00:02:30.000Z"),
          escrow: {
            state: "overdrawn",
            funds: [{ amount: "-6344.131225000000000000", denom: "uakt" }],
            transferred: [{ amount: "-1.0", denom: "uakt" }],
          },
        }),
      })
    ).rejects.toThrow(/non-negative plain decimal/);
    await store.observe({
      allocationReceiptId,
      evidence: evidence({ observedAt: new Date("2026-09-15T00:01:00.000Z") }),
    });
    await expect(
      store.observe({
        allocationReceiptId,
        evidence: evidence({
          ...current,
          escrow: { ...current.escrow, state: "forged" },
        }),
      })
    ).rejects.toThrow(/same observedAt/);

    await store.observe({
      allocationReceiptId,
      evidence: evidence({
        observedAt: new Date("2026-09-15T00:03:00.000Z"),
        providerClosedAtPosition: "150",
        escrow: {
          state: "overdrawn",
          providerSettledAtPosition: "151",
          funds: [{ amount: "-6344.131225000000000000", denom: "uakt" }],
          transferred: [{ amount: "21", denom: "uakt" }],
        },
      }),
    });
    await store.observe({
      allocationReceiptId,
      evidence: evidence({
        observedAt: new Date("2026-09-15T00:04:00.000Z"),
        escrow: {
          state: "overdrawn",
          providerSettledAtPosition: "152",
          funds: [{ amount: "-6344.131225000000000000", denom: "uakt" }],
          transferred: [{ amount: "22", denom: "uakt" }],
        },
      }),
    });
    const [closed] = await db.select().from(computeCostIntervals);
    expect(closed).toMatchObject({
      state: "closed",
      providerClosedAtPosition: "150",
      providerSettledAtPosition: "152",
      escrowFunds: [{ amount: "-6344.131225000000000000", denom: "uakt" }],
      cumulativeTransferred: [{ amount: "22", denom: "uakt" }],
    });
  });

  it("scopes provider resource identity by raw consumer account", async () => {
    const first = await allocated("k1", "7001");
    await store.bind({
      allocationReceiptId: first,
      resource: resource("7001"),
    });
    await store.observe({ allocationReceiptId: first, evidence: evidence() });

    const second = await allocated("k2", "7001");
    await expect(
      store.bind({
        allocationReceiptId: second,
        resource: resource("7001"),
      })
    ).rejects.toThrow(/another receipt/);

    const third = await allocated("k3", "7001");
    await store.bind({
      allocationReceiptId: third,
      resource: resource("7001", "akash1consumer-two"),
    });
    await expect(
      store.observe({
        allocationReceiptId: third,
        evidence: evidence({
          providerConsumerAccountId: "akash1consumer-two",
        }),
      })
    ).resolves.toBeUndefined();
  });

  it("never regresses updatedAt when evidence or a later local close crosses DB time", async () => {
    const allocationReceiptId = await allocated();
    await store.bind({
      allocationReceiptId,
      resource: resource("7001"),
    });
    const future = new Date("2099-01-01T00:00:00.000Z");
    await store.observe({
      allocationReceiptId,
      evidence: evidence({ observedAt: future }),
    });
    await store.close({ allocationReceiptId });

    const [row] = await db.select().from(computeCostIntervals);
    expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(future.getTime());
  });
});
