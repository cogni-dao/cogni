// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/confidence-policy`
 * Purpose: Unit coverage for the central confidence policy — initialize, recompute, and guards.
 * Scope: Pure domain policy assertions; does not connect to the database, adapters, or any I/O.
 * Invariants: CONFIDENCE_IS_POLICY, DERIVED_CONFIDENCE_REQUIRES_BASIS, NO_NULL_CONFIDENCE_WRITES.
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/confidence-policy.ts, docs/spec/knowledge-syntropy.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_POLICY_VERSION,
  ConfidencePolicyError,
  clampConfidence,
  explainConfidence,
  initializeConfidence,
  recomputeConfidence,
} from "../src/domain/confidence-policy.js";
import { KnowledgeEntryInputSchema } from "../src/domain/contribution-schemas.js";

describe("initializeConfidence — baselines by source type", () => {
  it("preserves an explicit, valid confidence value", () => {
    const d = initializeConfidence({ sourceType: "agent", confidencePct: 88 });
    expect(d.confidencePct).toBe(88);
    expect(d.basis).toBe("explicit:agent");
    expect(d.policyVersion).toBe(CONFIDENCE_POLICY_VERSION);
  });

  it("agent → 30 when confidence is omitted", () => {
    expect(initializeConfidence({ sourceType: "agent" }).confidencePct).toBe(
      30
    );
  });

  it("analysis_signal → 40 when confidence is omitted", () => {
    expect(
      initializeConfidence({ sourceType: "analysis_signal" }).confidencePct
    ).toBe(40);
  });

  it("external → 50 when confidence is omitted", () => {
    expect(initializeConfidence({ sourceType: "external" }).confidencePct).toBe(
      50
    );
  });

  it("human → 70 when confidence is omitted", () => {
    expect(initializeConfidence({ sourceType: "human" }).confidencePct).toBe(
      70
    );
  });

  it("treats null confidence as omitted (NO_NULL_CONFIDENCE_WRITES)", () => {
    expect(
      initializeConfidence({ sourceType: "human", confidencePct: null })
        .confidencePct
    ).toBe(70);
  });
});

describe("initializeConfidence — derived initialize-then-recompute", () => {
  it("initializes derived to the conservative baseline (40) without a cited basis", () => {
    const d = initializeConfidence({ sourceType: "derived" });
    expect(d.confidencePct).toBe(40);
    expect(d.basis).toBe("derived:baseline");
  });

  it("falls back to baseline when a citation lacks citedConfidencePct", () => {
    const d = initializeConfidence(
      { sourceType: "derived" },
      { citations: [{ citationType: "supports" }] }
    );
    expect(d.confidencePct).toBe(40);
    expect(d.basis).toBe("derived:baseline");
  });

  it("derives the minimum cited confidence when a basis is present", () => {
    const d = initializeConfidence(
      { sourceType: "derived" },
      {
        citations: [
          { citationType: "supports", citedConfidencePct: 70 },
          { citationType: "supports", citedConfidencePct: 45 },
        ],
      }
    );
    expect(d.confidencePct).toBe(45);
    expect(d.basis).toBe("derived:min-cited-confidence");
  });

  it("preserves explicit confidence even for derived", () => {
    expect(
      initializeConfidence({ sourceType: "derived", confidencePct: 60 })
        .confidencePct
    ).toBe(60);
  });
});

describe("initializeConfidence — principal cap + value guards", () => {
  it("caps agent principals at 30 even for higher-baseline sources", () => {
    expect(
      initializeConfidence(
        { sourceType: "external" },
        { principalKind: "agent" }
      ).confidencePct
    ).toBe(30);
  });

  it("does not cap user principals", () => {
    expect(
      initializeConfidence(
        { sourceType: "external" },
        { principalKind: "user" }
      ).confidencePct
    ).toBe(50);
  });

  it.each([
    150,
    -1,
    3.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid explicit confidence %p", (value) => {
    expect(() =>
      initializeConfidence({ sourceType: "agent", confidencePct: value })
    ).toThrow(ConfidencePolicyError);
  });
});

describe("recomputeConfidence — citation-driven adjustment", () => {
  it("bumps by support and clamps the support contribution", () => {
    const d = recomputeConfidence({ sourceType: "agent" }, [
      { citationType: "supports" },
      { citationType: "validates" },
    ]);
    expect(d.confidencePct).toBe(50); // 30 + 10 + 10
  });

  it("penalizes contradictions", () => {
    const d = recomputeConfidence({ sourceType: "human" }, [
      { citationType: "contradicts" },
    ]);
    expect(d.confidencePct).toBe(55); // 70 - 15
  });

  it("recomputes derived from a conservative base without throwing", () => {
    const d = recomputeConfidence({ sourceType: "derived" }, [
      { citationType: "supports" },
    ]);
    expect(d.confidencePct).toBe(50); // 40 + 10
  });
});

describe("CONFIDENCE_NOT_AUTHOR_SET — confidence is not a caller input", () => {
  it("drops confidencePct from a knowledge entry input (no write surface accepts it)", () => {
    const parsed = KnowledgeEntryInputSchema.parse({
      domain: "meta",
      title: "an entry",
      content: "body",
      confidencePct: 95,
    } as Record<string, unknown>);
    expect("confidencePct" in parsed).toBe(false);
  });

  it("accepts the same input without confidencePct (the field is simply gone)", () => {
    const parsed = KnowledgeEntryInputSchema.parse({
      domain: "meta",
      title: "an entry",
      content: "body",
    });
    expect(parsed.title).toBe("an entry");
    expect("confidencePct" in parsed).toBe(false);
  });
});

describe("helpers", () => {
  it("clamps to [0,100]", () => {
    expect(clampConfidence(-5)).toBe(0);
    expect(clampConfidence(120)).toBe(100);
    expect(clampConfidence(42)).toBe(42);
  });

  it("explainConfidence is inspectable", () => {
    const d = initializeConfidence({ sourceType: "agent" });
    expect(explainConfidence(d)).toBe(
      `${CONFIDENCE_POLICY_VERSION}:baseline:agent:30`
    );
  });
});
