// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/compose-holdings`
 * Purpose: Verifies holdings composition uses claimant display names rather than raw user IDs.
 * Scope: Unit tests for finalized holdings UI composition only. Does not test HTTP routes or database queries.
 * Invariants:
 * - DISPLAY_NAMES_FROM_CLAIMANTS: holdings render claimant display names from finalized read models
 * - NO_GUID_DISPLAY: holdings must not fall back to raw user ID prefixes
 * Side-effects: none
 * Links: src/features/governance/lib/compose-holdings.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { composeHoldings } from "@/features/governance/lib/compose-holdings";

describe("composeHoldings", () => {
  it("derives user-facing names from activity receipts instead of user ids", () => {
    const data = composeHoldings(
      [
        {
          id: "21",
          status: "finalized",
          periodStart: "2026-02-17T00:00:00.000Z",
          periodEnd: "2026-02-24T00:00:00.000Z",
          weightConfig: {
            "github:pr_merged": 8000,
          },
          poolTotalCredits: "10000",
        },
      ],
      [
        {
          epochId: "21",
          poolTotalCredits: "10000",
          items: [
            {
              claimantKey: "user:d0000000-0000-4000-a000-000058641509",
              claimant: {
                kind: "user",
                userId: "d0000000-0000-4000-a000-000058641509",
              },
              displayName: "derekg1729",
              isLinked: true,
              totalUnits: "8000",
              share: "0.800000",
              amountCredits: "8000",
              receiptIds: ["r1"],
            },
            {
              claimantKey: "identity:github:207977700",
              claimant: {
                kind: "identity",
                provider: "github",
                externalId: "207977700",
                providerLogin: "Cogni-1729",
              },
              displayName: "Cogni-1729",
              isLinked: false,
              totalUnits: "2000",
              share: "0.200000",
              amountCredits: "2000",
              receiptIds: ["r2"],
            },
          ],
        },
      ]
    );

    expect(data.holdings.map((holding) => holding.displayName)).toEqual([
      "derekg1729",
      "Cogni-1729",
    ]);
    expect(
      data.holdings.some((holding) => holding.displayName?.includes("d0000000"))
    ).toBe(false);
  });
});
