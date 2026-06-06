// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/attribution-ledger/allocation`
 * Purpose: Unit tests for computeProposedAllocations, validateWeightConfig, and deriveAllocationAlgoRef.
 * Scope: Asserts weight-sum-v0 algorithm correctness, deterministic ordering, weight overrides, empty inputs, and weight validation. Does not test store or I/O.
 * Invariants: ALLOCATION_ALGO_VERSIONED, ALL_MATH_BIGINT, WEIGHTS_VALIDATED.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/allocation.ts
 * @internal
 */

import {
  type CuratedEventForAllocation,
  computeProposedAllocations,
  deriveAllocationAlgoRef,
  validateWeightConfig,
} from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";

const weightConfig: Record<string, number> = {
  "github:pr_merged": 1000,
  "github:review_submitted": 500,
  "github:issue_closed": 300,
};

function makeEvent(
  overrides: Partial<CuratedEventForAllocation> & {
    eventId: string;
    userId: string;
  }
): CuratedEventForAllocation {
  return {
    source: "github",
    eventType: "pr_merged",
    included: true,
    weightOverrideMilli: null,
    ...overrides,
  };
}

describe("computeProposedAllocations", () => {
  it("computes allocations for weight-sum-v0", () => {
    const events: CuratedEventForAllocation[] = [
      makeEvent({ eventId: "e1", userId: "alice" }),
      makeEvent({
        eventId: "e2",
        userId: "bob",
        eventType: "review_submitted",
      }),
      makeEvent({ eventId: "e3", userId: "alice" }),
    ];

    const result = computeProposedAllocations(
      "weight-sum-v0",
      events,
      weightConfig
    );

    expect(result).toHaveLength(2);
    // alice: 2 pr_merged → 2 * 1000 = 2000
    expect(result[0]).toEqual({
      userId: "alice",
      proposedUnits: 2000n,
      activityCount: 2,
    });
    // bob: 1 review_submitted → 500
    expect(result[1]).toEqual({
      userId: "bob",
      proposedUnits: 500n,
      activityCount: 1,
    });
  });

  it("filters out excluded events", () => {
    const events: CuratedEventForAllocation[] = [
      makeEvent({ eventId: "e1", userId: "alice" }),
      makeEvent({ eventId: "e2", userId: "bob", included: false }),
    ];

    const result = computeProposedAllocations(
      "weight-sum-v0",
      events,
      weightConfig
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("alice");
  });

  it("uses weightOverrideMilli when present", () => {
    const events: CuratedEventForAllocation[] = [
      makeEvent({
        eventId: "e1",
        userId: "alice",
        weightOverrideMilli: 5000n,
      }),
    ];

    const result = computeProposedAllocations(
      "weight-sum-v0",
      events,
      weightConfig
    );

    expect(result[0]?.proposedUnits).toBe(5000n);
  });

  it("returns empty array for empty events", () => {
    const result = computeProposedAllocations(
      "weight-sum-v0",
      [],
      weightConfig
    );

    expect(result).toEqual([]);
  });

  it("returns deterministic order (sorted by userId)", () => {
    const events: CuratedEventForAllocation[] = [
      makeEvent({ eventId: "e1", userId: "zara" }),
      makeEvent({ eventId: "e2", userId: "alice" }),
      makeEvent({ eventId: "e3", userId: "mike" }),
    ];

    const result = computeProposedAllocations(
      "weight-sum-v0",
      events,
      weightConfig
    );

    expect(result.map((a) => a.userId)).toEqual(["alice", "mike", "zara"]);
  });

  it("defaults to 0 weight for unknown event types", () => {
    const events: CuratedEventForAllocation[] = [
      makeEvent({
        eventId: "e1",
        userId: "alice",
        eventType: "unknown_type",
      }),
    ];

    const result = computeProposedAllocations(
      "weight-sum-v0",
      events,
      weightConfig
    );

    expect(result[0]?.proposedUnits).toBe(0n);
  });

  it("throws for unknown algorithm ref", () => {
    expect(() =>
      computeProposedAllocations("unknown-algo", [], weightConfig)
    ).toThrow("Unknown allocation algorithm: unknown-algo");
  });

  it("produces identical output for same inputs (deterministic)", () => {
    const events: CuratedEventForAllocation[] = [
      makeEvent({ eventId: "e1", userId: "bob" }),
      makeEvent({ eventId: "e2", userId: "alice" }),
    ];

    const r1 = computeProposedAllocations(
      "weight-sum-v0",
      events,
      weightConfig
    );
    const r2 = computeProposedAllocations(
      "weight-sum-v0",
      events,
      weightConfig
    );

    expect(r1).toEqual(r2);
  });
});

describe("validateWeightConfig", () => {
  it("accepts valid integer config", () => {
    expect(() =>
      validateWeightConfig({ "github:pr_merged": 1000 })
    ).not.toThrow();
  });

  it("rejects NaN", () => {
    expect(() => validateWeightConfig({ "github:pr_merged": NaN })).toThrow(
      "must be finite"
    );
  });

  it("rejects Infinity", () => {
    expect(() =>
      validateWeightConfig({ "github:pr_merged": Infinity })
    ).toThrow("must be finite");
  });

  it("rejects floats", () => {
    expect(() => validateWeightConfig({ "github:pr_merged": 1.5 })).toThrow(
      "must be an integer"
    );
  });

  it("rejects unsafe integers", () => {
    expect(() =>
      validateWeightConfig({
        "github:pr_merged": Number.MAX_SAFE_INTEGER + 1,
      })
    ).toThrow("exceeds safe integer range");
  });

  it("accepts empty config", () => {
    expect(() => validateWeightConfig({})).not.toThrow();
  });

  it("accepts zero and negative values", () => {
    expect(() => validateWeightConfig({ a: 0, b: -100 })).not.toThrow();
  });
});

describe("deriveAllocationAlgoRef", () => {
  it("maps cogni-v0.0 to weight-sum-v0", () => {
    expect(deriveAllocationAlgoRef("cogni-v0.0")).toBe("weight-sum-v0");
  });

  it("throws for unknown algo", () => {
    expect(() => deriveAllocationAlgoRef("unknown")).toThrow(
      "Unknown attribution_pipeline"
    );
  });
});
