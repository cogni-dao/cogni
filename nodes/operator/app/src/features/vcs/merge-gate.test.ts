// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { CiStatusResult } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import { classifyMergeFailure, evaluateMergeGate } from "./merge-gate";

/** A green, mergeable PR on main — the only input that passes the gate. */
function greenCi(overrides: Partial<CiStatusResult> = {}): CiStatusResult {
  return {
    prNumber: 1776,
    prTitle: "feat: thing",
    author: "flock-leader",
    baseBranch: "main",
    headSha: "a".repeat(40),
    mergeable: true,
    reviewDecision: null,
    labels: [],
    draft: false,
    allGreen: true,
    pending: false,
    checks: [],
    ...overrides,
  };
}

describe("evaluateMergeGate", () => {
  it("passes a green, mergeable PR targeting main", () => {
    expect(evaluateMergeGate(greenCi())).toBeNull();
  });

  it("rejects a non-main base", () => {
    expect(
      evaluateMergeGate(greenCi({ baseBranch: "deploy/preview" }))
    ).toEqual(
      expect.objectContaining({ status: 422, errorCode: "wrong_base" })
    );
  });

  it("rejects a draft PR", () => {
    expect(evaluateMergeGate(greenCi({ draft: true }))).toEqual(
      expect.objectContaining({ status: 422, errorCode: "pr_draft" })
    );
  });

  it("rejects when checks are not all green", () => {
    expect(evaluateMergeGate(greenCi({ allGreen: false }))).toEqual(
      expect.objectContaining({ status: 422, errorCode: "not_green" })
    );
  });

  it("rejects when checks are still pending (even if allGreen is true)", () => {
    expect(evaluateMergeGate(greenCi({ pending: true }))).toEqual(
      expect.objectContaining({ status: 422, errorCode: "not_green" })
    );
  });

  it("rejects an unmergeable PR (conflicts)", () => {
    expect(evaluateMergeGate(greenCi({ mergeable: false }))).toEqual(
      expect.objectContaining({ status: 422, errorCode: "pr_not_mergeable" })
    );
  });

  it("rejects (retryable) when mergeability is still computing (null)", () => {
    const r = evaluateMergeGate(greenCi({ mergeable: null }));
    expect(r).toEqual(
      expect.objectContaining({ status: 422, errorCode: "pr_not_mergeable" })
    );
    expect(r?.error).toMatch(/computing|retry/i);
  });

  it("checks base before greenness (base failure wins)", () => {
    expect(
      evaluateMergeGate(greenCi({ baseBranch: "x", allGreen: false }))
        ?.errorCode
    ).toBe("wrong_base");
  });
});

describe("classifyMergeFailure", () => {
  it("maps GitHub 405 to merge_rejected (409)", () => {
    expect(classifyMergeFailure(405, "Pull Request is not mergeable")).toEqual(
      expect.objectContaining({ status: 409, errorCode: "merge_rejected" })
    );
  });

  it("maps GitHub 409 to head_modified (409)", () => {
    expect(classifyMergeFailure(409, "Head branch was modified")).toEqual(
      expect.objectContaining({ status: 409, errorCode: "head_modified" })
    );
  });

  it("maps an unknown / missing status to merge_failed (502)", () => {
    expect(classifyMergeFailure(undefined, "boom")).toEqual(
      expect.objectContaining({ status: 502, errorCode: "merge_failed" })
    );
    expect(classifyMergeFailure(500, "boom").errorCode).toBe("merge_failed");
  });

  it("preserves GitHub's message", () => {
    expect(classifyMergeFailure(405, "specific reason").error).toBe(
      "specific reason"
    );
  });
});
