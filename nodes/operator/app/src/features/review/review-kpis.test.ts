// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/review/review-kpis.test`
 * Purpose: Prove the PR-review goal-KPI calculators (task.5450) over an in-memory source: a merged head
 *   with a passing App review is covered; neutral, failure, a pass after the merge and no review are not;
 *   zero merges, truncation and an unconfigured repo are unavailable (never 0); a failed review is fixed
 *   only by a pass on a different head.
 * Side-effects: none
 */

import type {
  CalculatorContext,
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import type {
  ReviewCheckFacts,
  ReviewKpiSourcePort,
  ReviewPrFacts,
  ReviewPrSelector,
} from "@/ports";
import {
  classifyFailures,
  classifyMerge,
  createReviewCalculators,
  FAIL_FIX_RATE_ID,
  MAX_REVIEW_PAGES,
  MERGE_COVERAGE_ID,
  REVIEW_PAGE_SIZE,
  UPDATED_LOOKBACK_MS,
} from "./review-kpis";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const REPO = { owner: "cogni-dao", repo: "cogni" };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow);

let nextCheckId = 1000;
function check(over: Partial<ReviewCheckFacts>): ReviewCheckFacts {
  return {
    id: nextCheckId++,
    headSha: SHA_A,
    status: "completed",
    conclusion: "success",
    completedAt: at(2 * DAY),
    ...over,
  };
}

function pr(over: Partial<ReviewPrFacts> & { number: number }): ReviewPrFacts {
  return {
    mergedAt: at(DAY),
    headSha: SHA_A,
    checks: [],
    incomplete: false,
    ...over,
  };
}

function source(input: {
  prs: ReviewPrFacts[];
  /** Pages of this size; default is one page holding everything. */
  pageSize?: number;
}): ReviewKpiSourcePort & { selectors: ReviewPrSelector[]; reads: number } {
  const size = input.pageSize ?? Math.max(1, input.prs.length);
  const selectors: ReviewPrSelector[] = [];
  const self = {
    selectors,
    reads: 0,
    pullRequestPage: async ({
      selector,
      cursor,
    }: {
      selector: ReviewPrSelector;
      cursor: string | undefined;
    }) => {
      self.reads++;
      selectors.push(selector);
      const start = cursor ? Number(cursor) : 0;
      const end = start + size;
      return {
        prs: input.prs.slice(start, end),
        nextCursor: end < input.prs.length ? String(end) : undefined,
        asOf: new Date(NOW),
      };
    },
  };
  return self;
}

/** Run one calculator the way the engine does: parse params, bounded reads, a 7-day window. */
async function run(
  src: ReviewKpiSourcePort,
  id: string,
  params: Record<string, unknown> = {},
  repo: typeof REPO | null = REPO
): Promise<MetricSample> {
  const calc = createReviewCalculators(src, {
    repo: repo ?? undefined,
  }).find((c) => c.id === id) as MetricCalculator;
  const windowMs = (calc.windowSeconds?.(params) ?? 0) * 1000;
  const controller = new AbortController();
  let calls = 0;
  const ctx: CalculatorContext = {
    window: {
      start: new Date(NOW - windowMs).toISOString(),
      end: new Date(NOW).toISOString(),
    },
    signal: controller.signal,
    budget: calc.budget,
    async read(fn) {
      if (++calls > calc.budget.maxSourceCalls)
        throw new Error("source_call_budget");
      return fn(controller.signal, calc.budget);
    },
  };
  return calc.compute(calc.paramsSchema.parse(params), ctx);
}

describe("classifyMerge", () => {
  const mergedAt = at(DAY);
  it("a completed success on the merged head before the merge covers it", () => {
    const c = check({ completedAt: at(DAY + HOUR) });
    expect(classifyMerge(pr({ number: 1, checks: [c] }), mergedAt)).toEqual({
      covered: true,
      check: c,
    });
  });
  it("neutral is not a pass", () => {
    const v = classifyMerge(
      pr({ number: 1, checks: [check({ conclusion: "neutral" })] }),
      mergedAt
    );
    expect(v).toEqual({ covered: false, reason: "neutral" });
  });
  it("a failure, an unfinished check and a missing review are not covered", () => {
    expect(
      classifyMerge(
        pr({ number: 1, checks: [check({ conclusion: "failure" })] }),
        mergedAt
      )
    ).toEqual({ covered: false, reason: "failure" });
    expect(
      classifyMerge(
        pr({
          number: 1,
          checks: [
            check({
              status: "in_progress",
              conclusion: undefined,
              completedAt: undefined,
            }),
          ],
        }),
        mergedAt
      )
    ).toEqual({ covered: false, reason: "not_completed" });
    expect(classifyMerge(pr({ number: 1 }), mergedAt)).toEqual({
      covered: false,
      reason: "no_review",
    });
  });
  it("a pass on an older head does not cover the merged head", () => {
    expect(
      classifyMerge(
        pr({ number: 1, checks: [check({ headSha: SHA_B })] }),
        mergedAt
      )
    ).toEqual({ covered: false, reason: "no_review" });
  });
  it("a pass that completes after the merge reviewed nothing", () => {
    expect(
      classifyMerge(
        pr({ number: 1, checks: [check({ completedAt: at(DAY - HOUR) })] }),
        mergedAt
      )
    ).toEqual({ covered: false, reason: "after_merge" });
  });
});

describe(MERGE_COVERAGE_ID, () => {
  const from = NOW - 7 * DAY;
  it("share of merged PRs with a passing review on the merged head", async () => {
    const passing = check({ completedAt: at(2 * DAY), id: 77 });
    const s = await run(
      source({
        prs: [
          pr({ number: 10, checks: [passing] }),
          pr({ number: 11, checks: [check({ conclusion: "neutral" })] }),
          pr({ number: 12, checks: [check({ conclusion: "failure" })] }),
          pr({ number: 13 }),
        ],
      }),
      MERGE_COVERAGE_ID
    );
    expect(s).toMatchObject({ complete: true, unit: "ratio", value: 0.25 });
    expect(s.evidenceRefs).toContain("review:merged=4,covered=1");
    expect(s.evidenceRefs).toContain(`covered:pr=10,check=77,sha=aaaaaaa`);
    expect(s.evidenceRefs).toContain("uncovered:pr=11,reason=neutral");
    expect(s.evidenceRefs).toContain("uncovered:pr=12,reason=failure");
    expect(s.evidenceRefs).toContain("uncovered:pr=13,reason=no_review");
    expect(s.evidenceRefs).toContain("repo:cogni-dao/cogni");
    expect(s.sourceWatermarks).toEqual([
      {
        source: "github_pull_requests",
        asOf: new Date(NOW).toISOString(),
      },
    ]);
  });
  it("asks the source for PRs merged in the half-open window", async () => {
    const src = source({ prs: [pr({ number: 1 })] });
    await run(src, MERGE_COVERAGE_ID);
    expect(src.selectors[0]).toEqual({
      kind: "merged",
      from: new Date(from),
      to: new Date(NOW),
    });
  });
  it("a merge at or after the window end, or before its start, is not counted", async () => {
    const s = await run(
      source({
        prs: [
          pr({ number: 1, checks: [check({})] }),
          pr({ number: 2, mergedAt: new Date(NOW) }),
          pr({ number: 3, mergedAt: new Date(from - 1) }),
          pr({ number: 4, mergedAt: undefined }),
        ],
      }),
      MERGE_COVERAGE_ID
    );
    expect(s).toMatchObject({ complete: true, value: 1 });
    expect(s.evidenceRefs).toContain("review:merged=1,covered=1");
  });
  it("zero merges is unavailable (zero_denominator), never 0", async () => {
    const s = await run(source({ prs: [] }), MERGE_COVERAGE_ID);
    expect(s).toMatchObject({ complete: false, reason: "zero_denominator" });
  });
  it("more pages than the budget is unavailable (truncated), never a partial ratio", async () => {
    const prs = Array.from({ length: MAX_REVIEW_PAGES + 1 }, (_, i) =>
      pr({ number: i + 1, checks: [check({})] })
    );
    const src = source({ prs, pageSize: 1 });
    const s = await run(src, MERGE_COVERAGE_ID);
    expect(s).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(src.reads).toBe(MAX_REVIEW_PAGES);
  });
  it("a PR whose commits or checks did not fit is unavailable", async () => {
    const s = await run(
      source({
        prs: [pr({ number: 1, checks: [check({})], incomplete: true })],
      }),
      MERGE_COVERAGE_ID
    );
    expect(s).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
  });
  it("an unconfigured repository is unavailable, never 0", async () => {
    const src = source({ prs: [pr({ number: 1 })] });
    const s = await run(src, MERGE_COVERAGE_ID, {}, null);
    expect(s).toMatchObject({ complete: false, reason: "source_failed" });
    expect(src.reads).toBe(0);
  });
  it("a source that throws surfaces to the engine (error), not as a number", async () => {
    const failing: ReviewKpiSourcePort = {
      pullRequestPage: async () => {
        throw new Error("auth failed");
      },
    };
    await expect(run(failing, MERGE_COVERAGE_ID)).rejects.toThrow(
      "auth failed"
    );
  });
  it("rejects unknown or out-of-range params", () => {
    const calc = createReviewCalculators(source({ prs: [] }), {
      repo: REPO,
    }).find((c) => c.id === MERGE_COVERAGE_ID) as MetricCalculator;
    expect(calc.paramsSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(calc.paramsSchema.safeParse({ days: 7, x: 1 }).success).toBe(false);
    expect(calc.paramsSchema.parse({})).toEqual({ days: 7 });
  });
});

describe("classifyFailures", () => {
  const from = at(7 * DAY);
  const to = new Date(NOW);
  it("a pass on a different head after the failure fixes it", () => {
    const fail = check({
      headSha: SHA_A,
      conclusion: "failure",
      completedAt: at(3 * DAY),
    });
    const pass = check({ headSha: SHA_B, completedAt: at(2 * DAY) });
    const [f] = classifyFailures(
      pr({ number: 5, checks: [fail, pass] }),
      from,
      to
    );
    expect(f?.fixedBy).toBe(pass);
  });
  it("a pass on the SAME head is a rerun, not a fix", () => {
    const fail = check({
      conclusion: "failure",
      completedAt: at(3 * DAY),
    });
    const rerun = check({ completedAt: at(2 * DAY) });
    const [f] = classifyFailures(
      pr({ number: 5, checks: [fail, rerun] }),
      from,
      to
    );
    expect(f?.fixedBy).toBeUndefined();
  });
  it("a pass on a different head BEFORE the failure is not a fix", () => {
    const earlier = check({ headSha: SHA_B, completedAt: at(4 * DAY) });
    const fail = check({ conclusion: "failure", completedAt: at(3 * DAY) });
    const [f] = classifyFailures(
      pr({ number: 5, checks: [earlier, fail] }),
      from,
      to
    );
    expect(f?.fixedBy).toBeUndefined();
  });
  it("neutral on a new head is not a fix, and repeated failures on one head are one failure", () => {
    const fail1 = check({ conclusion: "failure", completedAt: at(3 * DAY) });
    const fail2 = check({ conclusion: "failure", completedAt: at(2 * DAY) });
    const neutral = check({
      headSha: SHA_B,
      conclusion: "neutral",
      completedAt: at(DAY),
    });
    const out = classifyFailures(
      pr({ number: 5, checks: [fail1, fail2, neutral] }),
      from,
      to
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.check).toBe(fail1);
    expect(out[0]?.fixedBy).toBeUndefined();
  });
  it("failures outside the window and passes at or after its end do not count", () => {
    const old = check({ conclusion: "failure", completedAt: at(8 * DAY) });
    const fail = check({ conclusion: "failure", completedAt: at(DAY) });
    const late = check({ headSha: SHA_B, completedAt: new Date(NOW) });
    const out = classifyFailures(
      pr({ number: 5, checks: [old, fail, late] }),
      from,
      to
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.fixedBy).toBeUndefined();
  });
});

describe(FAIL_FIX_RATE_ID, () => {
  it("share of failed reviews fixed by a later pass on a different head", async () => {
    const failFixed = check({
      id: 1,
      headSha: SHA_A,
      conclusion: "failure",
      completedAt: at(3 * DAY),
    });
    const fix = check({ id: 2, headSha: SHA_B, completedAt: at(2 * DAY) });
    const failSame = check({
      id: 3,
      conclusion: "failure",
      completedAt: at(3 * DAY),
    });
    const rerun = check({ id: 4, completedAt: at(2 * DAY) });
    const failOpen = check({
      id: 5,
      headSha: SHA_C,
      conclusion: "failure",
      completedAt: at(DAY),
    });
    const src = source({
      prs: [
        pr({ number: 20, checks: [failFixed, fix] }),
        pr({ number: 21, checks: [failSame, rerun] }),
        pr({ number: 22, mergedAt: undefined, checks: [failOpen] }),
        pr({ number: 23, checks: [check({})] }),
      ],
    });
    const s = await run(src, FAIL_FIX_RATE_ID);
    expect(s).toMatchObject({ complete: true, unit: "ratio", value: 0.3333 });
    expect(s.evidenceRefs).toContain("review:failed=3,fixed=1");
    expect(s.evidenceRefs).toContain(
      "fixed:pr=20,failed_check=1,failed_sha=aaaaaaa,fixed_check=2,fixed_sha=bbbbbbb"
    );
    expect(s.evidenceRefs).toContain("unfixed:pr=21,check=3,sha=aaaaaaa");
    expect(s.evidenceRefs).toContain("unfixed:pr=22,check=5,sha=ccccccc");
    // PRs touched shortly before the window can still hold a review that failed inside it.
    expect(src.selectors[0]).toEqual({
      kind: "updated",
      since: new Date(NOW - 7 * DAY - UPDATED_LOOKBACK_MS),
    });
  });
  it("no failed reviews is unavailable (zero_denominator), never 0", async () => {
    const s = await run(
      source({ prs: [pr({ number: 1, checks: [check({})] })] }),
      FAIL_FIX_RATE_ID
    );
    expect(s).toMatchObject({ complete: false, reason: "zero_denominator" });
  });
  it("truncation is unavailable, never a partial ratio", async () => {
    const prs = Array.from(
      { length: MAX_REVIEW_PAGES * REVIEW_PAGE_SIZE + 1 },
      (_, i) => pr({ number: i + 1 })
    );
    const s = await run(
      source({ prs, pageSize: REVIEW_PAGE_SIZE }),
      FAIL_FIX_RATE_ID
    );
    expect(s).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
  });
  it("an unconfigured repository is unavailable, never 0", async () => {
    const s = await run(source({ prs: [] }), FAIL_FIX_RATE_ID, {}, null);
    expect(s).toMatchObject({ complete: false, reason: "source_failed" });
  });
});
