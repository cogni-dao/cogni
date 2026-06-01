// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/review/gates/review-limits`
 * Purpose: Built-in gate that checks PR size limits without LLM.
 * Scope: Pure numeric comparison of file count and diff size. Does not call LLM or external APIs.
 * Invariants: No LLM calls. Returns pass if within limits, neutral if exceeds.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

import type { EvidenceBundle, GateResult } from "../types";

interface ReviewLimitsConfig {
  readonly max_changed_files?: number | undefined;
  readonly max_total_diff_kb?: number | undefined;
}

/**
 * Evaluate PR against size limits.
 * Returns "pass" if within limits, "neutral" if exceeds (not blocking by default).
 */
export function evaluateReviewLimits(
  evidence: EvidenceBundle,
  config: ReviewLimitsConfig
): GateResult {
  const issues: string[] = [];

  if (
    config.max_changed_files !== undefined &&
    evidence.changedFiles > config.max_changed_files
  ) {
    issues.push(
      `Changed files (${evidence.changedFiles}) exceeds limit (${config.max_changed_files})`
    );
  }

  if (config.max_total_diff_kb !== undefined) {
    const diffKb = Math.round(evidence.totalDiffBytes / 1024);
    if (diffKb > config.max_total_diff_kb) {
      issues.push(
        `Diff size (${diffKb} KB) exceeds limit (${config.max_total_diff_kb} KB)`
      );
    }
  }

  if (issues.length > 0) {
    return {
      gateId: "review-limits",
      gateType: "review-limits",
      status: "neutral",
      summary: `PR exceeds size limits: ${issues.join("; ")}`,
    };
  }

  return {
    gateId: "review-limits",
    gateType: "review-limits",
    status: "pass",
    summary: `PR within size limits (${evidence.changedFiles} files, ${Math.round(evidence.totalDiffBytes / 1024)} KB)`,
  };
}
