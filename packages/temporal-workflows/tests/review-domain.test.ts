// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/tests/review-domain.test`
 * Purpose: Unit tests for PR review domain logic (pure functions).
 * Scope: Criteria evaluation, status aggregation, markdown formatting. Does not test activities or I/O.
 * Invariants: none
 * Side-effects: none
 * Links: packages/temporal-workflows/src/domain/review.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  aggregateGateStatuses,
  collectCitations,
  evaluateCriteria,
  findRequirement,
  formatCheckRunSummary,
  formatCrossDomainRefusal,
  formatNoScopeNeutral,
  formatPrComment,
  formatReviewResultBlock,
  formatThreshold,
  type ReviewResult,
} from "../src/domain/review.js";

describe("evaluateCriteria", () => {
  it("returns pass when all require thresholds met", () => {
    const scores = new Map([
      ["quality", 0.9],
      ["coverage", 0.8],
    ]);
    const criteria = {
      require: [
        { metric: "quality", gte: 0.8 },
        { metric: "coverage", gte: 0.7 },
      ],
      neutral_on_missing_metrics: false,
    };
    expect(evaluateCriteria(scores, criteria)).toBe("pass");
  });

  it("returns fail when any require threshold not met", () => {
    const scores = new Map([["quality", 0.5]]);
    const criteria = {
      require: [{ metric: "quality", gte: 0.8 }],
      neutral_on_missing_metrics: false,
    };
    expect(evaluateCriteria(scores, criteria)).toBe("fail");
  });

  it("returns neutral for missing metrics when flag set", () => {
    const scores = new Map<string, number>();
    const criteria = {
      require: [{ metric: "quality", gte: 0.8 }],
      neutral_on_missing_metrics: true,
    };
    expect(evaluateCriteria(scores, criteria)).toBe("neutral");
  });

  it("returns pass when any_of has at least one pass", () => {
    const scores = new Map([
      ["a", 0.3],
      ["b", 0.9],
    ]);
    const criteria = {
      any_of: [
        { metric: "a", gte: 0.8 },
        { metric: "b", gte: 0.8 },
      ],
      neutral_on_missing_metrics: false,
    };
    expect(evaluateCriteria(scores, criteria)).toBe("pass");
  });

  it("returns fail when no any_of thresholds met", () => {
    const scores = new Map([
      ["a", 0.3],
      ["b", 0.4],
    ]);
    const criteria = {
      any_of: [
        { metric: "a", gte: 0.8 },
        { metric: "b", gte: 0.8 },
      ],
      neutral_on_missing_metrics: false,
    };
    expect(evaluateCriteria(scores, criteria)).toBe("fail");
  });
});

describe("aggregateGateStatuses", () => {
  it("returns fail if any gate failed", () => {
    expect(aggregateGateStatuses(["pass", "fail", "pass"])).toBe("fail");
  });

  it("returns neutral if any gate neutral and none failed", () => {
    expect(aggregateGateStatuses(["pass", "neutral", "pass"])).toBe("neutral");
  });

  it("returns pass if all gates passed", () => {
    expect(aggregateGateStatuses(["pass", "pass"])).toBe("pass");
  });

  it("returns pass for empty array", () => {
    expect(aggregateGateStatuses([])).toBe("pass");
  });
});

describe("formatThreshold", () => {
  it("formats gte threshold", () => {
    expect(formatThreshold({ metric: "q", gte: 0.8 })).toBe("\u2265 0.80");
  });

  it("formats gt threshold", () => {
    expect(formatThreshold({ metric: "q", gt: 0.5 })).toBe("> 0.50");
  });

  it("returns undefined for unknown operator", () => {
    expect(formatThreshold({ metric: "q" })).toBeUndefined();
  });
});

describe("findRequirement", () => {
  it("finds requirement in require array", () => {
    const criteria = {
      require: [{ metric: "quality", gte: 0.8 }],
      neutral_on_missing_metrics: false,
    };
    expect(findRequirement("quality", criteria)).toBe("\u2265 0.80 (all)");
  });

  it("finds requirement in any_of array", () => {
    const criteria = {
      any_of: [{ metric: "speed", lte: 0.5 }],
      neutral_on_missing_metrics: false,
    };
    expect(findRequirement("speed", criteria)).toBe("\u2264 0.50 (any)");
  });

  it("returns undefined for unknown metric", () => {
    const criteria = {
      require: [{ metric: "quality", gte: 0.8 }],
      neutral_on_missing_metrics: false,
    };
    expect(findRequirement("unknown", criteria)).toBeUndefined();
  });
});

describe("formatCheckRunSummary", () => {
  const result: ReviewResult = {
    conclusion: "pass",
    gateResults: [
      {
        gateId: "test-gate",
        gateType: "ai-rule",
        status: "pass",
        summary: 'Rule "test-gate" passed',
      },
    ],
  };

  it("includes verdict label", () => {
    const summary = formatCheckRunSummary(result);
    expect(summary).toContain("PASS");
  });

  it("includes gate counts", () => {
    const summary = formatCheckRunSummary(result);
    expect(summary).toContain("1 passed");
    expect(summary).toContain("0 failed");
  });

  it("includes DAO link for failures", () => {
    const failResult: ReviewResult = {
      conclusion: "fail",
      gateResults: [
        {
          gateId: "g",
          gateType: "ai-rule",
          status: "fail",
          summary: "failed",
        },
      ],
    };
    const summary = formatCheckRunSummary(failResult, {
      daoBaseUrl: "https://dao.example.com",
    });
    expect(summary).toContain("Propose DAO Vote");
  });
});

describe("formatPrComment", () => {
  const result: ReviewResult = {
    conclusion: "fail",
    gateResults: [
      {
        gateId: "code-quality",
        gateType: "ai-rule",
        status: "fail",
        summary: 'Rule "code-quality" failed',
        metrics: [
          {
            metric: "readability",
            score: 0.4,
            requirement: "\u2265 0.80 (all)",
            observation: "Code is hard to read",
          },
        ],
      },
    ],
  };

  it("includes blocker details with metrics table", () => {
    const comment = formatPrComment(result);
    expect(comment).toContain("Blockers");
    expect(comment).toContain("code-quality");
    expect(comment).toContain("readability");
    expect(comment).toContain("0.40");
  });

  it("includes check run link when provided", () => {
    const comment = formatPrComment(result, {
      checkRunUrl: "https://github.com/org/repo/runs/123",
    });
    expect(comment).toContain("View Details");
  });

  it("includes staleness marker when headSha provided", () => {
    const comment = formatPrComment(result, { headSha: "abc1234567890" });
    expect(comment).toContain("cogni:summary v1 sha=abc1234");
  });
});

describe("formatCrossDomainRefusal", () => {
  it("names the conflicting domains and operator-territory paths", () => {
    const body = formatCrossDomainRefusal({
      kind: "conflict",
      nodes: [
        { nodeId: "operator", path: "nodes/operator" },
        { nodeId: "poly", path: "nodes/poly" },
      ],
      operatorPaths: [
        "packages/repo-spec/src/bar.ts",
        ".github/workflows/ci.yaml",
      ],
      operatorNodeId: "operator",
    });
    expect(body).toContain("Cross-Domain PR refused");
    expect(body).toContain("`operator`");
    expect(body).toContain("`poly`");
    expect(body).toContain("Operator-territory paths");
    expect(body).toContain("packages/repo-spec/src/bar.ts");
    expect(body).toContain(".github/workflows/ci.yaml");
    expect(body).toContain("File an operator PR");
    expect(body).toContain("single-node-scope");
  });

  it("for non-operator multi-domain conflict, omits operator section and instructs split", () => {
    const body = formatCrossDomainRefusal({
      kind: "conflict",
      nodes: [
        { nodeId: "poly", path: "nodes/poly" },
        { nodeId: "resy", path: "nodes/resy" },
      ],
      operatorPaths: [],
    });
    expect(body).toContain("`poly`");
    expect(body).toContain("`resy`");
    expect(body).not.toContain("Operator-territory paths");
    expect(body).toContain("Split this PR");
  });

  it("truncates long operator-path lists", () => {
    const operatorPaths = Array.from({ length: 25 }, (_, i) => `docs/f${i}.md`);
    const body = formatCrossDomainRefusal({
      kind: "conflict",
      nodes: [
        { nodeId: "operator", path: "nodes/operator" },
        { nodeId: "poly", path: "nodes/poly" },
      ],
      operatorPaths,
      operatorNodeId: "operator",
    });
    expect(body).toContain("docs/f0.md");
    expect(body).toContain("docs/f19.md");
    expect(body).not.toContain("docs/f20.md");
    expect(body).toContain("and 5 more");
  });
});

describe("formatNoScopeNeutral", () => {
  it("explains why review is being skipped", () => {
    const body = formatNoScopeNeutral();
    expect(body).toContain("No recognizable scope");
    expect(body).toContain("Skipping review");
    expect(body).toContain("single-node-scope");
  });
});

describe("review result block (CHECK_IS_REQUEST_BOUND, story.5102)", () => {
  it("renders the exact wire format the pr-review eval parses", () => {
    const block = {
      requestId: "r",
      buildSha: "b",
      model: "m",
      conclusion: "failure" as const,
      couldNotEvaluate: null,
      citations: ["rule-a"],
      evidence: { files: ["a.ts"], entries: ["rule-a"] },
    };
    expect(formatReviewResultBlock(block)).toBe(
      `\n<!-- cogni-review-result v1 -->\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\`\n`
    );
  });

  it("collects the union of metric citations in first-seen order", () => {
    expect(
      collectCitations({
        metrics: [
          { metric: "a", value: 1, observations: [], citations: ["x", "y"] },
          { metric: "b", value: 1, observations: [] },
          { metric: "c", value: 0, observations: [], citations: ["y", "z"] },
        ],
        summary: "",
      })
    ).toEqual(["x", "y", "z"]);
    expect(collectCitations(undefined)).toEqual([]);
  });

  it("a could-not-evaluate summary says so before the verdict", () => {
    const summary = formatCheckRunSummary({
      conclusion: "fail",
      gateResults: [],
      couldNotEvaluate: "graph_failed",
    });
    expect(summary).toContain("COULD NOT EVALUATE");
    expect(summary).toContain("graph_failed");
  });
});
