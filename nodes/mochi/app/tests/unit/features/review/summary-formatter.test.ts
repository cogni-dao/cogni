// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/review/summary-formatter`
 * Purpose: Unit tests for Check Run summary and PR comment markdown formatting.
 * Scope: Tests overall structure, per-gate sections, metrics tables, counts line, gate ordering, DAO vote link, and attribution footer. Does NOT test GitHub API.
 * Invariants: Pure function — no side-effects, no mocking needed.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  formatCheckRunSummary,
  formatPrComment,
} from "@/features/review/summary-formatter";
import type { ReviewResult } from "@/features/review/types";

const passResult: ReviewResult = {
  conclusion: "pass",
  gateResults: [
    {
      gateId: "review-limits",
      gateType: "review-limits",
      status: "pass",
      summary: "PR within size limits (3 files, 2 KB)",
    },
    {
      gateId: "code-quality",
      gateType: "ai-rule",
      status: "pass",
      summary: 'Rule "code-quality" passed',
      metrics: [
        {
          metric: "coherence",
          score: 0.92,
          observation: "Changes are coherent",
        },
        { metric: "clarity", score: 0.85, observation: "Code is clear" },
      ],
    },
  ],
};

const failResult: ReviewResult = {
  conclusion: "fail",
  gateResults: [
    {
      gateId: "code-quality",
      gateType: "ai-rule",
      status: "fail",
      summary: 'Rule "code-quality" failed threshold checks',
      metrics: [
        { metric: "coherence", score: 0.4, observation: "Scattered changes" },
      ],
    },
    {
      gateId: "review-limits",
      gateType: "review-limits",
      status: "pass",
      summary: "PR within size limits",
    },
  ],
};

const mixedResult: ReviewResult = {
  conclusion: "fail",
  gateResults: [
    {
      gateId: "passing-gate",
      gateType: "review-limits",
      status: "pass",
      summary: "OK",
    },
    {
      gateId: "failing-gate",
      gateType: "ai-rule",
      status: "fail",
      summary: "Failed",
      metrics: [{ metric: "quality", score: 0.3, observation: "Poor quality" }],
    },
    {
      gateId: "neutral-gate",
      gateType: "timeout",
      status: "neutral",
      summary: "Timed out",
    },
  ],
};

describe("formatCheckRunSummary", () => {
  it("includes verdict line", () => {
    const md = formatCheckRunSummary(passResult);
    expect(md).toContain("PASS");
  });

  it("includes counts line", () => {
    const md = formatCheckRunSummary(passResult);
    expect(md).toMatch(/2 passed/);
    expect(md).toMatch(/0 failed/);
    expect(md).toMatch(/0 neutral/);
  });

  it("includes per-gate sections", () => {
    const md = formatCheckRunSummary(passResult);
    expect(md).toContain("review-limits");
    expect(md).toContain("code-quality");
  });

  it("includes metrics table with Requirement column", () => {
    const md = formatCheckRunSummary(passResult);
    expect(md).toContain("| Metric | Score | Requirement | Observation |");
    expect(md).toContain("| coherence |");
    expect(md).toContain("92%");
    // No requirement set in fixture → dash placeholder
    expect(md).toContain("| \u2014 |");
  });

  it("renders requirement threshold when present", () => {
    const withReq: ReviewResult = {
      conclusion: "pass",
      gateResults: [
        {
          gateId: "test-gate",
          gateType: "ai-rule",
          status: "pass",
          summary: "Passed",
          metrics: [
            {
              metric: "quality",
              score: 0.9,
              requirement: "\u2265 0.80",
              observation: "Good",
            },
          ],
        },
      ],
    };
    const md = formatCheckRunSummary(withReq);
    expect(md).toContain("| \u2265 0.80 |");
  });

  it("sorts gates: fail first, then pass, then neutral", () => {
    const md = formatCheckRunSummary(mixedResult);
    const failPos = md.indexOf("failing-gate");
    const passPos = md.indexOf("passing-gate");
    const neutralPos = md.indexOf("neutral-gate");
    expect(failPos).toBeLessThan(passPos);
    expect(passPos).toBeLessThan(neutralPos);
  });

  it("includes DAO vote link on failure when daoBaseUrl provided", () => {
    const md = formatCheckRunSummary(failResult, {
      daoBaseUrl: "https://dao.example.com",
    });
    expect(md).toContain("Propose DAO Vote to Merge");
    expect(md).toContain("https://dao.example.com");
  });

  it("omits DAO vote link on pass", () => {
    const md = formatCheckRunSummary(passResult, {
      daoBaseUrl: "https://dao.example.com",
    });
    expect(md).not.toContain("Propose DAO Vote to Merge");
  });

  it("omits DAO vote link when no opts", () => {
    const md = formatCheckRunSummary(failResult);
    expect(md).not.toContain("Propose DAO Vote to Merge");
  });
});

describe("formatPrComment", () => {
  it("includes header with verdict", () => {
    const md = formatPrComment(failResult);
    expect(md).toContain("Cogni Review");
    expect(md).toContain("FAIL");
  });

  it("includes gate counts", () => {
    const md = formatPrComment(failResult);
    expect(md).toContain("1 passed");
    expect(md).toContain("1 failed");
  });

  it("shows blockers with metric tables for failed gates", () => {
    const md = formatPrComment(failResult);
    expect(md).toContain("Blockers");
    expect(md).toContain("code-quality");
    expect(md).toContain("| coherence |");
    expect(md).toContain("| 0.40 |");
  });

  it("includes View Details link when checkRunUrl provided", () => {
    const md = formatPrComment(passResult, {
      checkRunUrl: "https://github.com/owner/repo/runs/123",
    });
    expect(md).toContain("[View Details]");
    expect(md).toContain("https://github.com/owner/repo/runs/123");
  });

  it("omits View Details link when no checkRunUrl", () => {
    const md = formatPrComment(passResult);
    expect(md).not.toContain("View Details");
  });

  it("includes staleness marker when headSha provided", () => {
    const md = formatPrComment(passResult, { headSha: "abc1234567890" });
    expect(md).toContain("<!-- cogni:summary v1 sha=abc1234");
  });

  it("omits staleness marker when no headSha", () => {
    const md = formatPrComment(passResult);
    expect(md).not.toContain("<!-- cogni:summary");
  });
});
