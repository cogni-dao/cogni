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
import { describe, expect, it } from "vitest";

import {
  computeBalanceReader,
  computeCostReaders,
  computeReportRows,
} from "@/adapters/server/finance/operator-finance.adapter";

const at = "2026-10-25T00:00:00.000Z";

describe("operator finance evidence", () => {
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

  it("does not report a funded account as healthy without burn", async () => {
    const reader = computeBalanceReader({
      balances: async () => [
        {
          provider: "cherry",
          accountId: "account",
          currency: "EUR",
          remaining: 36,
          asOf: at,
          estimatedDaysRemaining: null,
        },
      ],
    });
    const row = await reader.read(new AbortController().signal);
    expect(row).toMatchObject({
      balance: 36,
      currency: "EUR",
      grade: "UNKNOWN",
      burnPerDay: null,
      runwayDays: null,
      sourceObservedAt: at,
    });
  });

  it("preserves exhausted balance risk without burn", async () => {
    const reader = computeBalanceReader({
      balances: async () => [
        {
          provider: "cherry",
          accountId: "account",
          currency: "EUR",
          remaining: 0,
          asOf: at,
          estimatedDaysRemaining: null,
        },
      ],
    });
    expect(await reader.read(new AbortController().signal)).toMatchObject({
      grade: "RED",
      runwayDays: 0,
    });
  });

  it("sanitizes provider failures and treats absent cost evidence as unknown", async () => {
    const reader = computeBalanceReader({
      balances: async () => {
        throw new Error("sensitive-token-value");
      },
    });
    const row = await reader.read(new AbortController().signal);
    expect(row.grade).toBe("UNKNOWN");
    expect(JSON.stringify(row)).not.toContain("sensitive-token-value");
    const [missing] = await computeCostReaders(async () => []);
    expect(await missing?.read(new AbortController().signal)).toMatchObject({
      grade: "UNKNOWN",
      balance: null,
    });
  });
});
