// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { evaluateNodeCapacity } from "@/features/nodes/capacity";

describe("evaluateNodeCapacity", () => {
  it("allows a birth strictly below the ceiling", () => {
    const d = evaluateNodeCapacity({ deployedNodeCount: 7, ceiling: 8 });
    expect(d.allowed).toBe(true);
    expect(d.deployedNodeCount).toBe(7);
    expect(d.ceiling).toBe(8);
  });

  it("blocks at the ceiling (the hand-back boundary)", () => {
    const d = evaluateNodeCapacity({ deployedNodeCount: 8, ceiling: 8 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/capacity/i);
  });

  it("blocks over the ceiling", () => {
    expect(
      evaluateNodeCapacity({ deployedNodeCount: 12, ceiling: 8 }).allowed
    ).toBe(false);
  });
});
