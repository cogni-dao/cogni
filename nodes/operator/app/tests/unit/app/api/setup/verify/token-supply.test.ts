// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/setup/verify/token-supply`
 * Purpose: Unit tests for DAO formation token supply verification decisions.
 * Scope: Pure comparison logic only; no RPC, route execution, or wallet IO.
 * Invariants: Variable DAO token supplies verify against the selected mint amount, not a hard-coded 1e18.
 * Side-effects: none
 * Links: src/app/api/setup/verify/route.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import { collectTokenSupplyVerificationErrors } from "@/app/api/setup/verify/route";

describe("collectTokenSupplyVerificationErrors", () => {
  it("accepts a non-1e18 selected supply when holder balance and totalSupply match", () => {
    const selectedSupply = 1_000_000n * 10n ** 18n;

    expect(
      collectTokenSupplyVerificationErrors({
        expectedSupply: selectedSupply,
        balance: selectedSupply,
        totalSupply: selectedSupply,
      })
    ).toEqual([]);
  });

  it("reports holder and totalSupply mismatches independently", () => {
    const expectedSupply = 1_000_000n * 10n ** 18n;

    expect(
      collectTokenSupplyVerificationErrors({
        expectedSupply,
        balance: 1n,
        totalSupply: 2n,
      })
    ).toEqual([
      `Genesis holder balance mismatch: expected ${expectedSupply.toString()}, got 1`,
      `Token totalSupply mismatch: expected ${expectedSupply.toString()}, got 2`,
    ]);
  });
});
