// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/review/criteria-evaluator`
 * Purpose: Unit tests for deterministic threshold evaluation of PR review success criteria.
 * Scope: Tests require[], any_of[], comparison operators, missing metrics, edge cases. Does NOT test LLM or I/O.
 * Invariants: Pure function — no side-effects, no mocking needed.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

import type { SuccessCriteria } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import {
  evaluateCriteria,
  findRequirement,
  formatThreshold,
} from "@/features/review/criteria-evaluator";

describe("evaluateCriteria", () => {
  describe("require[] — all must pass", () => {
    it("returns pass when all thresholds met", () => {
      const scores = new Map([["quality", 0.9]]);
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: false,
        require: [{ metric: "quality", gte: 0.8 }],
      };
      expect(evaluateCriteria(scores, criteria)).toBe("pass");
    });

    it("returns fail when a threshold is not met", () => {
      const scores = new Map([["quality", 0.5]]);
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: false,
        require: [{ metric: "quality", gte: 0.8 }],
      };
      expect(evaluateCriteria(scores, criteria)).toBe("fail");
    });

    it("returns fail on missing metric when neutral_on_missing_metrics is false", () => {
      const scores = new Map<string, number>();
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: false,
        require: [{ metric: "quality", gte: 0.8 }],
      };
      expect(evaluateCriteria(scores, criteria)).toBe("fail");
    });

    it("returns neutral on missing metric when neutral_on_missing_metrics is true", () => {
      const scores = new Map<string, number>();
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: true,
        require: [{ metric: "quality", gte: 0.8 }],
      };
      expect(evaluateCriteria(scores, criteria)).toBe("neutral");
    });

    it("evaluates multiple require thresholds — fails on first failure", () => {
      const scores = new Map([
        ["quality", 0.9],
        ["coherence", 0.3],
      ]);
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: false,
        require: [
          { metric: "quality", gte: 0.8 },
          { metric: "coherence", gte: 0.7 },
        ],
      };
      expect(evaluateCriteria(scores, criteria)).toBe("fail");
    });
  });

  describe("any_of[] — at least one must pass", () => {
    it("returns pass when one of several passes", () => {
      const scores = new Map([
        ["a", 0.3],
        ["b", 0.9],
      ]);
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: false,
        any_of: [
          { metric: "a", gte: 0.8 },
          { metric: "b", gte: 0.8 },
        ],
      };
      expect(evaluateCriteria(scores, criteria)).toBe("pass");
    });

    it("returns fail when none passes", () => {
      const scores = new Map([
        ["a", 0.3],
        ["b", 0.4],
      ]);
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: false,
        any_of: [
          { metric: "a", gte: 0.8 },
          { metric: "b", gte: 0.8 },
        ],
      };
      expect(evaluateCriteria(scores, criteria)).toBe("fail");
    });

    it("returns neutral when none passes but some are neutral", () => {
      const scores = new Map([["a", 0.3]]);
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: true,
        any_of: [
          { metric: "a", gte: 0.8 },
          { metric: "missing", gte: 0.5 },
        ],
      };
      expect(evaluateCriteria(scores, criteria)).toBe("neutral");
    });
  });

  describe("comparison operators", () => {
    const baseCriteria = (op: Record<string, unknown>): SuccessCriteria => ({
      neutral_on_missing_metrics: false,
      require: [{ metric: "x", ...op }],
    });

    it("gt — strict greater than", () => {
      expect(
        evaluateCriteria(new Map([["x", 0.81]]), baseCriteria({ gt: 0.8 }))
      ).toBe("pass");
      expect(
        evaluateCriteria(new Map([["x", 0.8]]), baseCriteria({ gt: 0.8 }))
      ).toBe("fail");
    });

    it("lte — less than or equal", () => {
      expect(
        evaluateCriteria(new Map([["x", 0.3]]), baseCriteria({ lte: 0.5 }))
      ).toBe("pass");
      expect(
        evaluateCriteria(new Map([["x", 0.6]]), baseCriteria({ lte: 0.5 }))
      ).toBe("fail");
    });

    it("lt — strict less than", () => {
      expect(
        evaluateCriteria(new Map([["x", 0.4]]), baseCriteria({ lt: 0.5 }))
      ).toBe("pass");
      expect(
        evaluateCriteria(new Map([["x", 0.5]]), baseCriteria({ lt: 0.5 }))
      ).toBe("fail");
    });

    it("eq — approximate equality", () => {
      expect(
        evaluateCriteria(new Map([["x", 0.8]]), baseCriteria({ eq: 0.8 }))
      ).toBe("pass");
      expect(
        evaluateCriteria(new Map([["x", 0.85]]), baseCriteria({ eq: 0.8 }))
      ).toBe("fail");
    });
  });

  describe("edge cases", () => {
    it("returns pass when no require and no any_of", () => {
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: false,
      };
      expect(evaluateCriteria(new Map(), criteria)).toBe("pass");
    });

    it("returns neutral when threshold has no recognized operator", () => {
      const criteria: SuccessCriteria = {
        neutral_on_missing_metrics: false,
        require: [{ metric: "x" }],
      };
      expect(evaluateCriteria(new Map([["x", 0.5]]), criteria)).toBe("neutral");
    });
  });
});

describe("formatThreshold", () => {
  it("formats gte operator", () => {
    expect(formatThreshold({ metric: "q", gte: 0.8 })).toBe("\u2265 0.80");
  });

  it("formats gt operator", () => {
    expect(formatThreshold({ metric: "q", gt: 0.5 })).toBe("> 0.50");
  });

  it("formats lte operator", () => {
    expect(formatThreshold({ metric: "q", lte: 0.3 })).toBe("\u2264 0.30");
  });

  it("formats lt operator", () => {
    expect(formatThreshold({ metric: "q", lt: 0.1 })).toBe("< 0.10");
  });

  it("formats eq operator", () => {
    expect(formatThreshold({ metric: "q", eq: 0.5 })).toBe("= 0.50");
  });

  it("returns undefined for no operator", () => {
    expect(formatThreshold({ metric: "q" })).toBeUndefined();
  });
});

describe("findRequirement", () => {
  it("finds threshold in require[]", () => {
    const criteria: SuccessCriteria = {
      neutral_on_missing_metrics: false,
      require: [{ metric: "quality", gte: 0.8 }],
    };
    expect(findRequirement("quality", criteria)).toBe("\u2265 0.80 (all)");
  });

  it("finds threshold in any_of[]", () => {
    const criteria: SuccessCriteria = {
      neutral_on_missing_metrics: false,
      any_of: [{ metric: "speed", lte: 0.5 }],
    };
    expect(findRequirement("speed", criteria)).toBe("\u2264 0.50 (any)");
  });

  it("returns undefined for unknown metric", () => {
    const criteria: SuccessCriteria = {
      neutral_on_missing_metrics: false,
      require: [{ metric: "quality", gte: 0.8 }],
    };
    expect(findRequirement("unknown", criteria)).toBeUndefined();
  });
});
