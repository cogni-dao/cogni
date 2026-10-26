// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `operator-finance.test`
 * Purpose: Prove per-day conversion of on-chain lease prices, one row per node, Cherry credit mapping, and the reader composition.
 * Scope: Pure projection and injected compute port fakes; no network or DB.
 * Invariants: No FX between currencies, no fabricated runway, provider errors never leak.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AKASH_RATE_SOURCE,
  akashHostingReaders,
  akashHostingRow,
  akashUsdPerDay,
  cherryCreditReader,
  readAkashReports,
  restoreCostLineGrades,
} from "@/adapters/server/finance/operator-finance.adapter";

import { uniqueWalletBindings } from "@/bootstrap/capabilities/finance-wallets";

const runtime = vi.hoisted(() => ({
  dao: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as string | undefined,
  account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  env: { EVM_RPC_URL: "https://rpc.example" } as Record<
    string,
    string | undefined
  >,
  balances: vi.fn(async () => [] as unknown[]),
  report: vi.fn(async () => [] as unknown[]),
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
vi.mock("@/shared/env", () => ({ serverEnv: () => runtime.env }));
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
  runtime.env = { EVM_RPC_URL: "https://rpc.example" };
  vi.clearAllMocks();
});
const at = "2026-10-25T00:00:00.000Z";
const node = (
  nodeId: string,
  activeRates: { amount: string; denom: string; unit: string }[],
  transferred: { amount: string; denom: string }[] = []
) => ({
  nodeId,
  allocatedIntervals: 0,
  activeIntervals: activeRates.length,
  closedIntervals: 0,
  activeRates,
  transferred,
});

describe("operator finance evidence", () => {
  it("converts an on-chain uact price per block to USD per day with 5.884 s/block", () => {
    expect(
      akashUsdPerDay({ amount: "2", denom: "uact", unit: "block" })
    ).toBeCloseTo((2 * (86_400 / 5.884)) / 1e6, 9);
    expect(akashUsdPerDay({ amount: "3", denom: "uact", unit: "day" })).toBe(
      3e-6
    );
    expect(
      akashUsdPerDay({ amount: "304", denom: "uact", unit: "month" })
    ).toBeCloseTo(1e-5, 12);
    expect(akashUsdPerDay({ amount: "2", denom: "uakt", unit: "block" })).toBe(
      null
    );
    expect(akashUsdPerDay({ amount: "2", denom: "uact", unit: "hour" })).toBe(
      null
    );
    expect(
      akashUsdPerDay({ amount: "nope", denom: "uact", unit: "block" })
    ).toBe(null);
  });
  it("projects one row per node with the exact native rate, transfers and attribution", () => {
    const row = akashHostingRow(
      node(
        "poly",
        [{ amount: "106.93", denom: "uact", unit: "block" }],
        [
          { amount: "4210000", denom: "uact" },
          { amount: "11", denom: "uakt" },
        ]
      ),
      at
    );
    expect(row).toMatchObject({
      plane: "akash:poly",
      label: "Akash hosting · poly",
      kind: "usage",
      balance: null,
      currency: "USD",
      runwayDays: null,
      grade: "INFO",
      source: AKASH_RATE_SOURCE,
      sourceObservedAt: null,
      payer: "Operator",
      beneficiary: "poly",
      coverage: "operator-covered",
      nativeRate: { amount: "106.93", currency: "uact", per: "block" },
      cumulativeVendorTransfer: { amount: "4210000", currency: "uact" },
    });
    expect(row.burnPerDay).toBeCloseTo(1.57, 2);
  });
  it("sums several priced leases on one node and marks unpriced or lease-less nodes unknown", () => {
    const two = akashHostingRow(
      node("red", [
        { amount: "1", denom: "uact", unit: "day" },
        { amount: "2", denom: "uact", unit: "day" },
        { amount: "9", denom: "uakt", unit: "block" },
      ]),
      at
    );
    expect(two.burnPerDay).toBeCloseTo(3e-6, 12);
    expect(two.nativeRate).toBeUndefined();
    expect(two.detail).toBe("2 active leases");
    expect(
      akashHostingRow(
        node("blue", [{ amount: "9", denom: "uakt", unit: "block" }]),
        at
      )
    ).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      burnPerDay: null,
      beneficiary: "blue",
    });
    expect(akashHostingRow(node("idle", []), at)).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "no_leases",
      burnPerDay: null,
    });
  });
  it("treats an unreadable or empty cost ledger as one unknown fleet row without leaking errors", async () => {
    const failed = await readAkashReports(async () => {
      throw new Error("sensitive-token-value");
    });
    expect(failed).toBeNull();
    for (const [reports, reasonCode] of [
      [null, "unreadable"],
      [[], "no_leases"],
    ] as const) {
      const readers = akashHostingReaders(reports, at);
      expect(readers).toHaveLength(1);
      const row = await readers[0]?.read(new AbortController().signal);
      expect(row).toMatchObject({
        plane: "akash:fleet",
        label: "Akash hosting",
        grade: "UNKNOWN",
        reasonCode,
        burnPerDay: null,
      });
      expect(JSON.stringify(row)).not.toContain("sensitive-token-value");
    }
  });
  it("keeps INFO on cost lines that the shared floor demoted for carrying no balance", async () => {
    const readers = akashHostingReaders(
      [node("poly", [{ amount: "2", denom: "uact", unit: "block" }])],
      at
    );
    const snapshot = await takeSnapshot(readers, { timeoutMs: 500 });
    expect(snapshot.rows[0]?.grade).toBe("UNKNOWN");
    const rows = restoreCostLineGrades(snapshot.rows);
    expect(rows[0]).toMatchObject({ grade: "INFO", runwayDays: null });
    expect(rows[0]?.burnPerDay).toBeCloseTo((2 * (86_400 / 5.884)) / 1e6, 9);
    const first = snapshot.rows[0];
    if (!first) throw new Error("Missing row");
    expect(
      restoreCostLineGrades([
        { ...first, reasonCode: "no_leases", burnPerDay: null },
      ])[0]?.grade
    ).toBe("UNKNOWN");
  });
  it("maps the Cherry team balance in its native currency with burn unmeasured", async () => {
    const signal = new AbortController().signal;
    const present = cherryCreditReader(async () => [
      {
        provider: "akash",
        accountId: "x",
        currency: "USD",
        remaining: 1,
        asOf: at,
        estimatedDaysRemaining: null,
      },
      {
        provider: "cherry",
        accountId: "team",
        currency: "EUR",
        remaining: 12.4,
        asOf: at,
        estimatedDaysRemaining: null,
      },
    ]);
    expect(await present.read(signal)).toMatchObject({
      plane: "cherry:account",
      label: "Cherry compute credit",
      kind: "prepaid",
      balance: 12.4,
      currency: "EUR",
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "burn_unmeasured",
      sourceObservedAt: at,
    });
    expect(await cherryCreditReader(async () => []).read(signal)).toMatchObject(
      { grade: "UNKNOWN", reasonCode: "unconfigured", balance: null }
    );
    expect(await cherryCreditReader(undefined).read(signal)).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
    });
    const thrown = await cherryCreditReader(async () => {
      throw new Error("sensitive-token-value");
    }).read(signal);
    expect(thrown).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
    });
    expect(JSON.stringify(thrown)).not.toContain("sensitive-token-value");
  });
  it("deduplicates one Base account across roles before reads, retaining missing roles", () => {
    const account = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const input = [
      {
        name: "treasury",
        isTreasury: true,
        label: "Treasury",
        address: account,
      },
      {
        name: "steward",
        label: "Steward",
        address: `0x${account.slice(2).toUpperCase()}`,
      },
      { name: "missing-a", label: "Missing A", address: undefined },
      { name: "missing-b", label: "Missing B", address: undefined },
    ];
    const result = uniqueWalletBindings(input);
    expect(result.map((row) => row.name)).toEqual([
      "treasury",
      "missing-a",
      "missing-b",
    ]);
    expect(result[0]?.label).toBe("Treasury · Steward");
    expect(
      uniqueWalletBindings([...input].reverse()).find((row) => row.isTreasury)
        ?.name
    ).toBe("steward");
    expect(input[0]?.label).toBe("Treasury");
  });
  it("composes wallets, OpenRouter, Cherry and Akash in order and reads a shared address once", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => ({ result: "0x989680" }),
    }));
    vi.stubGlobal("fetch", fetch);
    const { readers, treasuryPlane } = await createFinanceReaders();
    expect(treasuryPlane).toBe("base:dao-treasury");
    expect(readers.map((reader) => reader.plane)).toEqual([
      "base:dao-treasury",
      "openrouter:account",
      "cherry:account",
      "akash:fleet",
    ]);
    const snapshot = await takeSnapshot(readers, { timeoutMs: 500 });
    expect(snapshot.rows[0]).toMatchObject({
      label:
        "DAO treasury · Operator wallet · working capital · Steward wallet · human custody",
      balance: 10,
      currency: "USDC",
      grade: "INFO",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(
        (call) => String(call[0]) === "https://rpc.example"
      )
    ).toBe(true);
    expect(snapshot.rows[1]).toMatchObject({
      label: "OpenRouter credit",
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
    });
    expect(runtime.balances).toHaveBeenCalledTimes(1);
    expect(runtime.report).toHaveBeenCalledTimes(1);
  });
  it("reads OpenRouter credit only when the key is present and leaves wallets unreadable without an RPC", async () => {
    runtime.env = { OPENROUTER_API_KEY: "sk-test" };
    const fetch = vi.fn(async (url: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes("openrouter")
          ? { data: { total_credits: 100, total_usage: 96.9 } }
          : { result: "0x0" },
    }));
    vi.stubGlobal("fetch", fetch);
    const { readers } = await createFinanceReaders();
    const snapshot = await takeSnapshot(readers, { timeoutMs: 500 });
    expect(snapshot.rows[0]).toMatchObject({
      kind: "wallet",
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      detail: "RPC unavailable",
    });
    expect(snapshot.rows[1]).toMatchObject({
      label: "OpenRouter credit",
      currency: "USD",
      grade: "UNKNOWN",
      reasonCode: "burn_unmeasured",
    });
    expect(snapshot.rows[1]?.balance).toBeCloseTo(3.1, 6);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer sk-test" },
    });
  });
});
