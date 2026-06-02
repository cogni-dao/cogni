// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/review/review-limits`
 * Purpose: Unit tests for PR size limit gate (no LLM, pure numeric comparison).
 * Scope: Tests file count, diff size, boundary conditions, and multi-violation reporting. Does NOT test LLM or GitHub API.
 * Invariants: Pure function — no side-effects, no mocking needed.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

import { describe, expect, it } from "vitest";

import { evaluateReviewLimits } from "@/features/review/gates/review-limits";
import type { EvidenceBundle } from "@/features/review/types";

function makeEvidence(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    prNumber: 1,
    prTitle: "test",
    prBody: "",
    headSha: "abc123",
    baseBranch: "main",
    changedFiles: 5,
    additions: 100,
    deletions: 20,
    patches: [],
    totalDiffBytes: 4096,
    ...overrides,
  };
}

describe("evaluateReviewLimits", () => {
  it("passes when within all limits", () => {
    const result = evaluateReviewLimits(makeEvidence(), {
      max_changed_files: 10,
      max_total_diff_kb: 50,
    });
    expect(result.status).toBe("pass");
    expect(result.gateId).toBe("review-limits");
  });

  it("returns neutral when file count exceeds limit", () => {
    const result = evaluateReviewLimits(makeEvidence({ changedFiles: 25 }), {
      max_changed_files: 10,
    });
    expect(result.status).toBe("neutral");
    expect(result.summary).toContain("25");
    expect(result.summary).toContain("10");
  });

  it("returns neutral when diff size exceeds limit", () => {
    const result = evaluateReviewLimits(
      makeEvidence({ totalDiffBytes: 200 * 1024 }),
      { max_total_diff_kb: 100 }
    );
    expect(result.status).toBe("neutral");
    expect(result.summary).toContain("200");
  });

  it("reports multiple limit violations in summary", () => {
    const result = evaluateReviewLimits(
      makeEvidence({ changedFiles: 50, totalDiffBytes: 500 * 1024 }),
      { max_changed_files: 10, max_total_diff_kb: 100 }
    );
    expect(result.status).toBe("neutral");
    expect(result.summary).toContain("files");
    expect(result.summary).toContain("Diff size");
  });

  it("passes when no limits are configured", () => {
    const result = evaluateReviewLimits(makeEvidence(), {});
    expect(result.status).toBe("pass");
  });

  it("passes at exact boundary", () => {
    const result = evaluateReviewLimits(
      makeEvidence({ changedFiles: 10, totalDiffBytes: 50 * 1024 }),
      { max_changed_files: 10, max_total_diff_kb: 50 }
    );
    expect(result.status).toBe("pass");
  });
});
