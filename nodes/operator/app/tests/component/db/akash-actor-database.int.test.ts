// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AkashActorDatabase } from "@/adapters/server/compute/akash-actor-database";
/**
 * Module: `@tests/component/db/akash-actor-database.int`
 * Purpose: Falsify whole-operation deadline and expired-admission behavior at the actual owner.
 * Scope: Disposable component database only; no provider calls or deployed credentials.
 * Invariants: One absolute deadline, no late callback admission, useful same-owner recovery.
 * Side-effects: IO (test-owned PostgreSQL)
 * Links: subtask.5033, adapters/server/compute/akash-actor-database
 * @internal
 */
import { getSeedDb } from "../../_fixtures/db/seed-client";

function owner(): AkashActorDatabase {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("component DATABASE_URL is required");
  return new AkashActorDatabase(url);
}

describe("AkashActorDatabase (native component)", () => {
  it("expires blocked concrete operations and admission, then recovers", async () => {
    const database = owner();
    const fixture = getSeedDb();
    const ledger = database.allocationLedger(
      "akash-console:akash1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    await fixture.transaction(async (locker) => {
      await locker.execute(
        sql`lock table public.akash_tx_allocations in access exclusive mode`
      );
      const blocked = ledger.claim({
        cogniKey: "r73-lock-deadline",
        workload: "fixture",
        environment: "candidate-a",
        identity: {
          nodeId: "c4b6415f-b64e-452c-b2ae-2e40f70809d3",
          compositeUid: "r73-blocked",
          compositeGeneration: 1,
        },
        deadlineAt: Date.now() + 150,
      });
      const observed = expect(blocked).rejects.toMatchObject({
        code: "outcome_unknown",
      });
      const started = performance.now();
      await expect(
        database.countLegacyScopedReceipts(Date.now() + 40)
      ).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(performance.now() - started).toBeLessThan(150);
      await observed;
    });
    await expect(
      database.countLegacyScopedReceipts(Date.now() + 1000)
    ).resolves.toBe(0);
    expect(Object.keys(database.allocationLedger("fixture"))).not.toContain(
      "run"
    );
  });
  it("routes every borrower through the same owner and returns materialized values", async () => {
    const database = owner();
    const deadlineAt = Date.now() + 5000;
    const wallet = "akash-console:akash1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ledger = database.allocationLedger(wallet);
    const bindings = database.bindingStore(wallet);
    const costs = database.costStore();
    const outcomes = [database.outcomeStore(), database.outcomeStore()];
    const reports = database.migrationReportStore();
    const cogniKey = "r70-owner-component";
    const identity = {
      nodeId: "c4b6415f-b64e-452c-b2ae-2e40f70809d3",
      compositeUid: "r70-owner",
      compositeGeneration: 1,
    };
    const claim = await ledger.claim({
      cogniKey,
      workload: "fixture",
      environment: "candidate-a",
      identity,
      deadlineAt,
    });
    if (claim.state !== "claimed")
      throw new Error("isolated component claim was not fresh");
    let record = await ledger.prepare({
      cogniKey,
      allocationCursor: "r70-cursor",
      expected: claim.record,
      deadlineAt,
    });
    record = await ledger.recordAllocation({
      cogniKey,
      externalName: "r70-fixture",
      providerAccount: "fixture-provider",
      expected: record,
      deadlineAt,
    });
    record = await ledger.recordAppliedSdlHash({
      cogniKey,
      sdlHash: "a".repeat(64),
      expected: record,
      deadlineAt,
    });
    await bindings.save(record, [], [], deadlineAt);
    const resource = {
      computeProvider: "akash",
      providerConsumerAccountId: "fixture-owner",
      resourceId: "r70-fixture",
    };
    await costs.bind({
      allocationReceiptId: record.receiptId,
      resource,
      deadlineAt,
    });
    await costs.observe({
      allocationReceiptId: record.receiptId,
      deadlineAt,
      evidence: {
        ...resource,
        providerSupplierAccountId: "fixture-provider",
        rate: { amount: "1", denom: "uact", unit: "block" },
        escrow: { state: "open", funds: [], transferred: [] },
        observedAt: new Date(),
      },
    });
    await Promise.all(
      outcomes.map((store) =>
        store.record(
          {
            computeProvider: "akash",
            providerAccount: "fixture-provider",
            outcome: "boot_ok",
            leaseId: "r70-fixture",
          },
          deadlineAt
        )
      )
    );
    await reports.record(
      {
        nodeId: identity.nodeId,
        environment: "candidate-a",
        declared: [],
        applied: [],
        reporter: "component",
      },
      deadlineAt
    );
    const values = await Promise.all([
      ledger.read({ cogniKey, deadlineAt }),
      ledger.listAllocated({ limit: 10, deadlineAt }),
      ledger.listActive({ limit: 10, deadlineAt }),
      ledger.listReceipts({ limit: 10, deadlineAt }),
      bindings.read(cogniKey, deadlineAt),
      costs.reportByNodeIds([identity.nodeId], deadlineAt),
      ...outcomes.map((store) => store.stats("akash", deadlineAt)),
      reports.read({
        nodeId: identity.nodeId,
        environment: "candidate-a",
        deadlineAt,
      }),
    ]);
    expect(values[0]).toMatchObject({ receiptId: record.receiptId });
    expect(values[4]).toEqual([]);
    expect(values.at(-1)).toMatchObject({ reporter: "component" });
    await costs.close({ allocationReceiptId: record.receiptId, deadlineAt });
    expect(await costs.reportByNode(deadlineAt)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: identity.nodeId,
          closedIntervals: 1,
        }),
      ])
    );
  });
});
