// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/evals/pr-review.score`
 * Purpose: Pin the pr-review eval grader and its block format.
 *   Covers block parsing, every fail and unscorable control, and the exit-code fold.
 * Scope: Pure grader tests over hand-made check summaries; does not call a node, GitHub or an LLM.
 * Invariants: GRADE_FROM_BLOCK_ONLY; UNSCORABLE_IS_NOT_A_VERDICT; CITED_MEANS_READ; EXIT_CODE_IS_VERDICT.
 * Side-effects: none
 * Links: evals/pr-review/score.ts, story.5102
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  type EvalCase,
  exitCodeFor,
  gradeCase,
  parseReviewBlock,
  REVIEW_RESULT_MARKER,
  type ReviewBlock,
} from "../../evals/pr-review/score";

/**
 * Mirror of `formatReviewResultBlock` (packages/temporal-workflows/src/domain/review.ts). The
 * worker side pins the same literal in packages/temporal-workflows/tests/review-domain.test.ts — the wire format.
 */
const formatReviewResultBlock = (b: ReviewBlock): string =>
  `\n<!-- cogni-review-result v1 -->\n\`\`\`json\n${JSON.stringify(b)}\n\`\`\`\n`;

const BUILD = "a".repeat(40);
const REQ = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const RULE = "check-reads-not-record";
const breaksRule: EvalCase = {
  id: "breaks-rule",
  prNumber: 1,
  expect: "failure",
  ruleId: RULE,
};
const compliant: EvalCase = { id: "compliant", prNumber: 2, expect: "success" };
const DIFF = ["nodes/operator/app/src/ready.ts"];

type Block = ReviewBlock;
const block = (over: Partial<Block> = {}): Block => ({
  requestId: REQ,
  buildSha: BUILD,
  model: "gemini-3.7-flash",
  conclusion: "failure",
  couldNotEvaluate: null,
  citations: [RULE],
  evidence: {
    files: ["nodes/operator/app/src/ready.ts", "docs/spec/health.md"],
    entries: [RULE],
  },
  ...over,
});
const summaryOf = (b: Block, prose = "**FAIL**") =>
  `${prose}\n${formatReviewResultBlock(b)}`;
const grade = (
  evalCase: EvalCase,
  summary: string | null,
  extra: { timedOut?: boolean } = {}
) =>
  gradeCase({
    evalCase,
    summary,
    requestId: REQ,
    candidateBuildSha: BUILD,
    diffFiles: DIFF,
    ...extra,
  });

describe("block format", () => {
  it("parses exactly what the worker formats (wire format parity)", () => {
    expect(REVIEW_RESULT_MARKER).toBe("<!-- cogni-review-result v1 -->");
    expect(parseReviewBlock(summaryOf(block()))).toEqual(block());
  });

  it("returns null for a missing marker, a broken fence or a malformed body", () => {
    expect(parseReviewBlock(null)).toBeNull();
    expect(parseReviewBlock("**FAIL** no block")).toBeNull();
    expect(
      parseReviewBlock(`${REVIEW_RESULT_MARKER}\n\`\`\`json\n{not json\n\`\`\``)
    ).toBeNull();
    expect(
      parseReviewBlock(
        `${REVIEW_RESULT_MARKER}\n\`\`\`json\n${JSON.stringify({ requestId: REQ })}\n\`\`\``
      )
    ).toBeNull();
  });
});

describe("gradeCase — pass", () => {
  it("passes a cited, read, beyond-the-diff failure for breaks-rule", () => {
    expect(grade(breaksRule, summaryOf(block()))).toEqual({
      caseId: "breaks-rule",
      status: "pass",
      reasons: [],
    });
  });

  it("passes a success for compliant (no citation needed)", () => {
    expect(
      grade(
        compliant,
        summaryOf(block({ conclusion: "success", citations: [] }))
      ).status
    ).toBe("pass");
  });
});

describe("gradeCase — fail controls", () => {
  it("fails on the wrong conclusion", () => {
    expect(
      grade(breaksRule, summaryOf(block({ conclusion: "success" })))
    ).toMatchObject({
      status: "fail",
      reasons: ["conclusion:success!=failure"],
    });
  });

  it("fails when the block's buildSha is not the candidate build", () => {
    expect(
      grade(breaksRule, summaryOf(block({ buildSha: "b".repeat(40) })))
        .reasons[0]
    ).toMatch(/^build_sha_mismatch/);
  });

  it("fails when the rule id appears only in prose/observations, not in citations", () => {
    const v = grade(
      breaksRule,
      summaryOf(
        block({ citations: [] }),
        `**FAIL** observation: breaks ${RULE} | cites: ${RULE}`
      )
    );
    expect(v).toMatchObject({
      status: "fail",
      reasons: [`rule_not_cited:${RULE}`],
    });
  });

  it("fails when the cited rule was not read this run", () => {
    expect(
      grade(
        breaksRule,
        summaryOf(
          block({
            evidence: { files: ["docs/spec/health.md"], entries: ["other"] },
          })
        )
      )
    ).toMatchObject({
      status: "fail",
      reasons: [`cited_rule_not_read:${RULE}`],
    });
  });

  it("fails when nothing outside the diff was read, or no hub entry was read", () => {
    expect(
      grade(
        compliant,
        summaryOf(
          block({
            conclusion: "success",
            citations: [],
            evidence: { files: DIFF, entries: [] },
          })
        )
      )
    ).toMatchObject({
      status: "fail",
      reasons: ["no_read_outside_diff", "no_hub_entry_read"],
    });
  });
});

describe("gradeCase — unscorable controls", () => {
  it("a timeout is unscorable", () => {
    expect(grade(breaksRule, null, { timedOut: true })).toMatchObject({
      status: "unscorable",
      reasons: ["timeout"],
    });
  });

  it("a missing block is unscorable", () => {
    expect(grade(breaksRule, "**FAIL** prose only").reasons).toEqual([
      "missing_block",
    ]);
    expect(grade(breaksRule, null).status).toBe("unscorable");
  });

  it("could-not-evaluate is unscorable even when it concludes failure", () => {
    expect(
      grade(
        breaksRule,
        summaryOf(block({ couldNotEvaluate: "uncited", conclusion: "failure" }))
      )
    ).toMatchObject({
      status: "unscorable",
      reasons: ["could_not_evaluate:uncited"],
    });
  });

  it("a block for another request is unscorable", () => {
    expect(
      grade(breaksRule, summaryOf(block({ requestId: "other" }))).reasons
    ).toEqual(["request_id_mismatch"]);
  });
});

describe("exitCodeFor", () => {
  const v = (status: "pass" | "fail" | "unscorable") => ({
    caseId: "x",
    status,
    reasons: [],
  });
  it("0 only when every case passes; 1 on any fail; else 3", () => {
    expect(exitCodeFor([v("pass"), v("pass")])).toBe(0);
    expect(exitCodeFor([v("pass"), v("fail")])).toBe(1);
    expect(exitCodeFor([v("fail"), v("unscorable")])).toBe(1);
    expect(exitCodeFor([v("pass"), v("unscorable")])).toBe(3);
    expect(exitCodeFor([])).toBe(3);
  });
});
