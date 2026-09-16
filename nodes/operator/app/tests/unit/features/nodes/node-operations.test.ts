// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Pure status and exact compute-format coverage for the node operations home. */

import type { NodeDeployState } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import {
  formatComputeAmount,
  formatComputeAmountDisplay,
  sumComputeAmounts,
} from "@/features/nodes/operations/format-cost";
import { deriveNodeOperationsStatus } from "@/features/nodes/operations/status";

function production(
  overrides: Partial<NodeDeployState & { declared: boolean }> = {}
): NodeDeployState & { declared: boolean } {
  return {
    env: "production",
    node: "alpha",
    sourceSha: "abc123",
    digest: null,
    buildSha: "abc123",
    health: "healthy",
    replicas: { desired: 1, ready: 1 },
    declared: true,
    ...overrides,
  };
}

describe("node operations status", () => {
  it("requires a running build and enforces source equality when source is observable", () => {
    expect(deriveNodeOperationsStatus("active", [production()])).toBe(
      "healthy"
    );
    expect(
      deriveNodeOperationsStatus("active", [production({ sourceSha: null })])
    ).toBe("healthy");
    expect(
      deriveNodeOperationsStatus("active", [production({ buildSha: null })])
    ).toBe("needs_attention");
    expect(
      deriveNodeOperationsStatus("active", [
        production({ buildSha: "different" }),
      ])
    ).toBe("needs_attention");
  });

  it("distinguishes undeployed, deploying, failed, and formation states", () => {
    expect(
      deriveNodeOperationsStatus("active", [production({ declared: false })])
    ).toBe("not_deployed");
    expect(
      deriveNodeOperationsStatus("active", [
        production({ health: "provisioning", buildSha: null }),
      ])
    ).toBe("deploying");
    expect(deriveNodeOperationsStatus("failed", [])).toBe("needs_attention");
    expect(deriveNodeOperationsStatus("published", [])).toBe("setting_up");
  });
});

describe("compute amount formatting", () => {
  it("formats fixed-decimal micro USD and AKT without Number coercion", () => {
    expect(
      formatComputeAmount({
        amount: "13910.000000000000000000",
        denom: "uact",
      })
    ).toBe("$0.01391");
    expect(formatComputeAmount({ amount: "2500000", denom: "uusdc" })).toBe(
      "$2.5"
    );
    expect(
      formatComputeAmount({ amount: "1000001.500000", denom: "uakt" })
    ).toBe("1.0000015 AKT");
    expect(formatComputeAmount({ amount: "42", denom: "ticks" })).toBe(
      "42 ticks"
    );
  });

  it("sums provider-native decimals exactly by denomination", () => {
    expect(
      sumComputeAmounts([
        [{ amount: "9007199254740993.1", denom: "uact" }],
        [
          { amount: "0.9", denom: "uact" },
          { amount: "5", denom: "ticks" },
        ],
      ])
    ).toEqual([
      { amount: "5", denom: "ticks" },
      { amount: "9007199254740994", denom: "uact" },
    ]);
  });

  it("shows concise USD money without losing low nonzero spend", () => {
    expect(
      formatComputeAmountDisplay({ amount: "341045", denom: "uact" })
    ).toBe("$0.34");
    expect(
      formatComputeAmountDisplay({ amount: "13910.000000", denom: "uusdc" })
    ).toBe("$0.01");
    expect(formatComputeAmountDisplay({ amount: "1", denom: "uact" })).toBe(
      "<$0.01"
    );
    expect(
      formatComputeAmountDisplay({ amount: "2500000", denom: "uact" })
    ).toBe("$2.5");
    expect(formatComputeAmountDisplay({ amount: "42", denom: "ticks" })).toBe(
      "42 ticks"
    );
  });
});
