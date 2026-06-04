// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/attribution-ledger/pool`
 * Purpose: Unit tests for estimatePoolComponentsV0 and validatePoolComponentId.
 * Scope: Asserts pool component estimation correctness and component ID validation. Does not test store or I/O.
 * Invariants: POOL_REPRODUCIBLE, ALL_MATH_BIGINT.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/pool.ts
 * @internal
 */

import {
  estimatePoolComponentsV0,
  validatePoolComponentId,
} from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";

describe("estimatePoolComponentsV0", () => {
  it("returns base_issuance component from config", () => {
    const result = estimatePoolComponentsV0({
      baseIssuanceCredits: 10000n,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      componentId: "base_issuance",
      algorithmVersion: "config-constant-v0",
      inputsJson: { baseIssuanceCredits: "10000" },
      amountCredits: 10000n,
    });
  });

  it("handles large values (ALL_MATH_BIGINT)", () => {
    const result = estimatePoolComponentsV0({
      baseIssuanceCredits: 999999999999n,
    });

    expect(result[0]?.amountCredits).toBe(999999999999n);
  });

  it("is pure — same inputs → same output", () => {
    const config = { baseIssuanceCredits: 5000n };
    const r1 = estimatePoolComponentsV0(config);
    const r2 = estimatePoolComponentsV0(config);
    expect(r1).toEqual(r2);
  });
});

describe("validatePoolComponentId", () => {
  it("accepts base_issuance", () => {
    expect(() => validatePoolComponentId("base_issuance")).not.toThrow();
  });

  it("accepts kpi_bonus_v0", () => {
    expect(() => validatePoolComponentId("kpi_bonus_v0")).not.toThrow();
  });

  it("accepts top_up", () => {
    expect(() => validatePoolComponentId("top_up")).not.toThrow();
  });

  it("rejects unknown component ID", () => {
    expect(() => validatePoolComponentId("unknown_component")).toThrow(
      "Unknown pool component ID"
    );
  });
});
