// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `operator-finance.test`
 * Purpose: Prove native cost evidence is complete and missing reads never look funded.
 * Scope: Pure projection and injected compute port fakes; no network or DB.
 * Invariants: No FX summing, repeated transfers or fabricated runway.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeCostReaders,
  computeRateEvidence,
  computeReportRows,
} from "@/adapters/server/finance/operator-finance.adapter";

import { uniqueWalletBindings } from "@/bootstrap/capabilities/finance-wallets";

const runtime = vi.hoisted(() => ({
  dao: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as string | undefined,
  account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  balances: vi.fn(),
  report: vi.fn(async () => []),
}));
vi.mock(
  "@/adapters/server",
  async () => import("@/adapters/server/finance/operator-finance.adapter")
);
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    akashSpendReader: { reportByNode: runtime.report },
    computeCapability: { balances: runtime.balances },
  }),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ EVM_RPC_URL: "https://rpc.example" }),
}));
vi.mock("@/shared/config", () => ({
  getDaoTreasuryAddress: () => runtime.dao,
  getOperatorWalletConfig: () => ({ address: runtime.account }),
  getStewardWalletConfig: () => ({ address: runtime.account }),
}));

import { takeSnapshot } from "@cogni/money-plane";
import { createFinanceReaders } from "@/bootstrap/capabilities/finance";

afterEach(() => {
  vi.unstubAllGlobals();
  runtime.dao = runtime.account;
  vi.clearAllMocks();
});
const at = "2026-10-25T00:00:00.000Z";

describe("operator finance evidence", () => {
  it("deduplicates one Base account across roles before reads, retaining missing roles", () => {
    const account = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const input = [
      {
        name: "treasury",
        isTreasury: true,
        label: "Treasury",
        address: account,
        beneficiary: "DAO",
        payer: "DAO",
      },
      {
        name: "steward",
        label: "Steward",
        address: `0x${account.slice(2).toUpperCase()}`,
        beneficiary: "Human custody",
        payer: "Unknown",
      },
      {
        name: "missing-a",
        label: "Missing A",
        address: undefined,
        beneficiary: "Unknown",
        payer: "Unknown",
      },
      {
        name: "missing-b",
        label: "Missing B",
        address: undefined,
        beneficiary: "Unknown",
        payer: "Unknown",
      },
    ];
    const result = uniqueWalletBindings(input);
    expect(result).toHaveLength(3);
    expect(
      uniqueWalletBindings([...input].reverse()).find((row) => row.isTreasury)
        ?.name
    ).toBe("steward");
    expect(result[0]?.beneficiary).toBe("DAO · Steward: Human custody");
    expect(result.slice(1).map((row) => row.name)).toEqual([
      "missing-a",
      "missing-b",
    ]);
    expect(input[0]?.beneficiary).toBe("DAO");
  });
  it("preserves all native rates and transfers without repeating a denomination total", () => {
    const rows = computeReportRows(
      [
        {
          nodeId: "node-a",
          allocatedIntervals: 0,
          activeIntervals: 2,
          closedIntervals: 1,
          activeRates: [
            { amount: "2.000000000000000001", denom: "uact", unit: "block" },
            { amount: "3", denom: "uact", unit: "day" },
          ],
          transferred: [
            { amount: "7.123456789012345678", denom: "uact" },
            { amount: "11", denom: "uakt" },
          ],
        },
      ],
      at
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.nativeRate).filter(Boolean)).toEqual([
      { amount: "2.000000000000000001", currency: "uact", per: "block" },
      { amount: "3", currency: "uact", per: "day" },
    ]);
    expect(
      rows.map((row) => row.cumulativeVendorTransfer).filter(Boolean)
    ).toEqual([
      { amount: "7.123456789012345678", currency: "uact" },
      { amount: "11", currency: "uakt" },
    ]);
    expect(
      rows.every(
        (row) =>
          row.grade === "UNKNOWN" &&
          row.sourceObservedAt === null &&
          row.coverage === "operator-covered"
      )
    ).toBe(true);
    expect(
      rows.every((row) => row.burnPerDay === null && row.runwayDays === null)
    ).toBe(true);
  });

  it("projects explicit operator contract cohorts without assigning node economic ownership", () => {
    const report = {
      nodeId: "node-a",
      allocatedIntervals: 0,
      activeIntervals: 2,
      closedIntervals: 1,
      activeRates: [
        { amount: "2", denom: "uact", unit: "block" },
        { amount: "3", denom: "uact", unit: "unknown" },
      ],
      transferred: [],
    };
    expect(computeRateEvidence([report])).toEqual([
      {
        sourceId: "akash-contract:node-a:uact:block",
        ownerId: "operator",
        scopeId: "operator-fleet",
        instrumentId: "akash:uact",
        basis: { kind: "contract", active: true },
        rate: { amount: "2", currency: "uact", per: "block" },
        sourceObservedAt: null,
        partial: true,
      },
    ]);
  });
  it("treats absent or failed cost evidence as unknown without exposing provider errors", async () => {
    for (const read of [
      async () => [],
      async () => {
        throw new Error("sensitive-token-value");
      },
    ]) {
      const { readers, costRateEvidence } = await computeCostReaders(read);
      const row = await readers[0]?.read(new AbortController().signal);
      expect(row).toMatchObject({ grade: "UNKNOWN", balance: null });
      expect(JSON.stringify(row)).not.toContain("sensitive-token-value");
      expect(costRateEvidence).toEqual([]);
    }
  });
  it("deduplicates triple aliases before RPC and calls neither Cherry nor OpenRouter", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => ({ result: "0x989680" }),
    }));
    vi.stubGlobal("fetch", fetch);
    const { readers, treasuryPlane, configuredWalletPlanes } =
      await createFinanceReaders();
    const snapshot = await takeSnapshot(readers, { timeoutMs: 500 });
    expect(snapshot.rows.filter((row) => row.kind === "wallet")).toHaveLength(
      1
    );
    expect(
      snapshot.rows.find((row) => row.plane === treasuryPlane)?.balance
    ).toBe(10);
    expect(configuredWalletPlanes).toEqual([treasuryPlane]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(
        (call) => String(call[0]) === "https://rpc.example"
      )
    ).toBe(true);
    expect(runtime.balances).not.toHaveBeenCalled();
    expect(
      snapshot.rows.find((row) => row.label === "OpenRouter")
    ).toMatchObject({ balance: null, grade: "UNKNOWN" });
  });
  it("preserves an unknown DAO role when only other custody has a configured address", async () => {
    runtime.dao = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: "0x989680" }),
      }))
    );
    const { readers, treasuryPlane, configuredWalletPlanes } =
      await createFinanceReaders();
    const snapshot = await takeSnapshot(readers, { timeoutMs: 500 });
    expect(configuredWalletPlanes).not.toContain(treasuryPlane);
    expect(configuredWalletPlanes).toEqual(["base:operator-wallet"]);
    expect(
      snapshot.rows.find((row) => row.plane === treasuryPlane)
    ).toMatchObject({ balance: null, grade: "UNKNOWN" });
    expect(snapshot.rows.filter((row) => row.kind === "wallet")).toHaveLength(
      2
    );
  });
});
