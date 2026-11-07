// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/evals/pr-review/score`
 * Purpose: Pure grader for the pr-review eval (story.5102 acceptance): parse the review check's
 *   machine-readable block and grade one case as pass, fail or unscorable; fold the cases into
 *   the exit code.
 * Scope: Pure functions over check summary, case, build SHA and diff files; does not perform IO.
 * Invariants:
 *   - GRADE_FROM_BLOCK_ONLY: grading reads ONLY the fenced JSON after REVIEW_RESULT_MARKER, never
 *     prose — a rule id that appears only in observations or the summary text does not count.
 *   - UNSCORABLE_IS_NOT_A_VERDICT: a timeout, a missing/invalid block, or a "could not evaluate"
 *     block is unscorable, never pass or fail.
 *   - CITED_MEANS_READ: a citation counts only if the same id is in evidence.entries.
 *   - EXIT_CODE_IS_VERDICT: 0 = every case passes; 1 = any case fails; 3 = otherwise unscorable.
 *   - BLOCK_FORMAT_MIRRORS_WORKER: the marker + JSON shape mirror `formatReviewResultBlock` in
 *     packages/temporal-workflows/src/domain/review.ts (a wire format, kept in sync by tests).
 * Side-effects: none
 * Links: evals/pr-review/README.md, run.ts, tests/evals/pr-review.score.test.ts,
 *   https://cognidao.org/knowledge/pr-review-grounded-gate
 * @public
 */

/** Marker before the one fenced JSON block that ends a review check summary. */
export const REVIEW_RESULT_MARKER = "<!-- cogni-review-result v1 -->";

/** The machine-readable review block (CHECK_IS_REQUEST_BOUND). */
export interface ReviewBlock {
  readonly requestId: string;
  readonly buildSha: string | null;
  readonly model: string;
  readonly conclusion: "success" | "failure" | "neutral";
  readonly couldNotEvaluate: string | null;
  readonly citations: readonly string[];
  readonly evidence: {
    readonly files: readonly string[];
    readonly entries: readonly string[];
  };
}

export interface EvalCase {
  readonly id: string;
  readonly prNumber: number;
  readonly expect: "failure" | "success";
  /** breaks-rule only: the governing hub rule the PR breaks; never named in the PR text. */
  readonly ruleId?: string;
}

export type CaseStatus = "pass" | "fail" | "unscorable";

export interface CaseVerdict {
  readonly caseId: string;
  readonly status: CaseStatus;
  readonly reasons: readonly string[];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Parse the block that follows the marker. Null when absent or malformed (→ unscorable). */
export function parseReviewBlock(
  summary: string | null | undefined
): ReviewBlock | null {
  if (!summary) return null;
  const at = summary.lastIndexOf(REVIEW_RESULT_MARKER);
  if (at < 0) return null;
  const match = summary
    .slice(at + REVIEW_RESULT_MARKER.length)
    .match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const evidence = v.evidence as Record<string, unknown> | undefined;
  if (
    typeof v.requestId !== "string" ||
    (v.buildSha !== null && typeof v.buildSha !== "string") ||
    typeof v.model !== "string" ||
    (v.conclusion !== "success" &&
      v.conclusion !== "failure" &&
      v.conclusion !== "neutral") ||
    (v.couldNotEvaluate !== null && typeof v.couldNotEvaluate !== "string") ||
    !isStringArray(v.citations) ||
    !evidence ||
    !isStringArray(evidence.files) ||
    !isStringArray(evidence.entries)
  )
    return null;
  return {
    requestId: v.requestId,
    buildSha: v.buildSha as string | null,
    model: v.model,
    conclusion: v.conclusion,
    couldNotEvaluate: v.couldNotEvaluate as string | null,
    citations: v.citations,
    evidence: { files: evidence.files, entries: evidence.entries },
  };
}

/** Grade one case from its check summary. */
export function gradeCase(input: {
  readonly evalCase: EvalCase;
  /** Check run output summary; null/undefined when no check was found. */
  readonly summary: string | null | undefined;
  /** The request id the verb returned; the block must carry the same id. */
  readonly requestId: string;
  readonly candidateBuildSha: string;
  /** Paths changed by the PR (GitHub PR files). */
  readonly diffFiles: readonly string[];
  readonly timedOut?: boolean;
}): CaseVerdict {
  const caseId = input.evalCase.id;
  const unscorable = (reason: string): CaseVerdict => ({
    caseId,
    status: "unscorable",
    reasons: [reason],
  });
  if (input.timedOut) return unscorable("timeout");
  const block = parseReviewBlock(input.summary);
  if (!block) return unscorable("missing_block");
  if (block.requestId !== input.requestId)
    return unscorable("request_id_mismatch");
  if (block.couldNotEvaluate)
    return unscorable(`could_not_evaluate:${block.couldNotEvaluate}`);

  const reasons: string[] = [];
  // 1. The candidate operator served this review.
  if (block.buildSha !== input.candidateBuildSha)
    reasons.push(
      `build_sha_mismatch:${block.buildSha ?? "null"}!=${input.candidateBuildSha}`
    );
  // 2. Conclusion.
  if (block.conclusion !== input.evalCase.expect)
    reasons.push(`conclusion:${block.conclusion}!=${input.evalCase.expect}`);
  // 3. Citation (breaks-rule): cited AND read this run.
  const ruleId = input.evalCase.ruleId;
  if (input.evalCase.expect === "failure" && ruleId) {
    if (!block.citations.includes(ruleId))
      reasons.push(`rule_not_cited:${ruleId}`);
    else if (!block.evidence.entries.includes(ruleId))
      reasons.push(`cited_rule_not_read:${ruleId}`);
  }
  // 4. Reading: beyond the diff, and the hub.
  const diff = new Set(input.diffFiles);
  if (!block.evidence.files.some((f) => !diff.has(f)))
    reasons.push("no_read_outside_diff");
  if (block.evidence.entries.length === 0) reasons.push("no_hub_entry_read");

  return { caseId, status: reasons.length ? "fail" : "pass", reasons };
}

/** EXIT_CODE_IS_VERDICT: any fail → 1; else any unscorable → 3; else 0. */
export function exitCodeFor(verdicts: readonly CaseVerdict[]): 0 | 1 | 3 {
  if (verdicts.length === 0) return 3;
  if (verdicts.some((v) => v.status === "fail")) return 1;
  if (verdicts.some((v) => v.status === "unscorable")) return 3;
  return 0;
}
