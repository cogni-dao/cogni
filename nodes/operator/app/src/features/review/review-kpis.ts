// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/review/review-kpis`
 * Purpose: The operator's node-local goal-metric calculators for PR review (task.5450, story.5145):
 *   `review.merge-coverage@1` (share of merged PRs whose head had a passing review before it merged) and
 *   `review.fail-fix-rate@1` (share of failed reviews that a later review on a different head passed).
 *   Registered through `@cogni-dao/metrics` 0.4 `createGoalMetrics({ nodeCalculators })`.
 * Scope: Pure classification and the calculator objects. Reads go through `ReviewKpiSourcePort`;
 *   this module does no IO itself. The repository comes from the operator's parent-repo env, never a literal.
 * Invariants:
 *   - APP_WRITTEN_ONLY: a review is a check run the review App wrote (the source port yields nothing
 *     else). Agent flags, PR text and comments are never read.
 *   - SUCCESS_IS_SUCCESS: only a completed `success` counts as a pass. `neutral` (a graph error or a
 *     could-not-evaluate result) is not a pass, a failure or a fix.
 *   - REVIEWED_BEFORE_MERGE: a merge is covered only by a pass on the PR's merged head that completed
 *     at or before `merged_at`. A pass that arrives after the merge reviewed nothing.
 *   - FAILURE_IS_A_HEAD: a failed review is one `(PR, head SHA)` whose first in-window completed
 *     `failure` is its instant. A rerun that fails again on the same head is the same failure.
 *   - FIX_IS_A_NEW_HEAD: a failure is fixed only by a `success` on a DIFFERENT head SHA of the same PR,
 *     completed after the failure and before the window end. A pass on the same head is a rerun, not a fix.
 *   - HALF_OPEN_WINDOW: events count by completed/merged time in `[end - days, end)`. A later pass
 *     never changes a closed window's merge coverage; fix-rate reads passes only before `end`.
 *   - UNKNOWN_IS_A_RESULT: no repository, a zero denominator, more PRs/commits/checks than the budget, or
 *     a failed source read yields an unavailable reading with a reason, never 0.
 *   - IDS_USE_DASHES: calculator ids match `MetricSpecSchema.calculatorId` (no underscores).
 * Side-effects: none (calculators call the injected source)
 * Links: ports/review-kpi.port.ts, adapters/server/review/review-kpi-source.adapter.ts,
 *   bootstrap/capabilities/goal-metrics.ts, task.5450, story.5145
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type {
  ReviewCheckFacts,
  ReviewKpiRepo,
  ReviewKpiSourcePort,
  ReviewPrFacts,
  ReviewPrSelector,
} from "@/ports";

export const MERGE_COVERAGE_ID = "review.merge-coverage@1";
export const FAIL_FIX_RATE_ID = "review.fail-fix-rate@1";

/** PRs per source read. */
export const REVIEW_PAGE_SIZE = 20;
/** Most source reads (pages) one reading makes. */
export const MAX_REVIEW_PAGES = 15;
/** Most PRs one reading covers; more is a truncated (unavailable) reading. */
export const MAX_REVIEW_PRS = REVIEW_PAGE_SIZE * MAX_REVIEW_PAGES;
/** A failed review's PR may have gone quiet; read PRs touched this long before the window starts. */
export const UPDATED_LOOKBACK_MS = 86_400_000;
/** Evidence refs list at most this many PRs per kind. */
const MAX_EVIDENCE = 20;
const DAY_MS = 86_400_000;

const daysSchema = z.number().int().min(1).max(28).default(7);

const reviewBudget = {
  timeoutMs: 40_000,
  maxSourceCalls: MAX_REVIEW_PAGES,
  maxRows: MAX_REVIEW_PRS,
  maxResponseBytes: 4_194_304,
};

const within = (at: Date, from: Date, to: Date) =>
  at.getTime() >= from.getTime() && at.getTime() < to.getTime();

const short = (sha: string) => sha.slice(0, 7);

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export type MergeCoverageVerdict =
  | { readonly covered: true; readonly check: ReviewCheckFacts }
  | {
      readonly covered: false;
      readonly reason:
        | "no_review"
        | "not_completed"
        | "neutral"
        | "failure"
        | "other_conclusion"
        | "after_merge";
    };

/**
 * Was this merged PR covered? Look at the review App's checks on the merged head only. A completed
 * success at or before the merge covers it; otherwise name the best reason it is not covered.
 */
export function classifyMerge(
  pr: ReviewPrFacts,
  mergedAt: Date
): MergeCoverageVerdict {
  const onHead = pr.checks.filter((c) => c.headSha === pr.headSha);
  if (onHead.length === 0) return { covered: false, reason: "no_review" };
  const passes = onHead.filter(
    (c) =>
      c.status === "completed" && c.conclusion === "success" && c.completedAt
  );
  const before = passes
    .filter((c) => (c.completedAt as Date).getTime() <= mergedAt.getTime())
    .sort(
      (a, b) =>
        (a.completedAt as Date).getTime() - (b.completedAt as Date).getTime()
    )[0];
  if (before) return { covered: true, check: before };
  if (passes.length > 0) return { covered: false, reason: "after_merge" };
  const done = onHead.filter((c) => c.status === "completed");
  if (done.length === 0) return { covered: false, reason: "not_completed" };
  if (done.some((c) => c.conclusion === "failure"))
    return { covered: false, reason: "failure" };
  if (done.some((c) => c.conclusion === "neutral"))
    return { covered: false, reason: "neutral" };
  return { covered: false, reason: "other_conclusion" };
}

export interface FailedReview {
  readonly pr: number;
  readonly headSha: string;
  /** The first completed in-window failure on this head. */
  readonly check: ReviewCheckFacts;
  /** The earliest later pass on a different head, if any. */
  readonly fixedBy: ReviewCheckFacts | undefined;
}

/** Every `(PR, head)` whose review failed in `[from, to)`, with the pass that fixed it, if any. */
export function classifyFailures(
  pr: ReviewPrFacts,
  from: Date,
  to: Date
): FailedReview[] {
  const completed = pr.checks.filter(
    (c) => c.status === "completed" && c.completedAt
  );
  const firstFailureByHead = new Map<string, ReviewCheckFacts>();
  for (const c of completed) {
    if (c.conclusion !== "failure") continue;
    if (!within(c.completedAt as Date, from, to)) continue;
    const seen = firstFailureByHead.get(c.headSha);
    if (
      !seen ||
      (c.completedAt as Date).getTime() < (seen.completedAt as Date).getTime()
    )
      firstFailureByHead.set(c.headSha, c);
  }
  const passes = completed
    .filter((c) => c.conclusion === "success")
    .sort(
      (a, b) =>
        (a.completedAt as Date).getTime() - (b.completedAt as Date).getTime()
    );
  return [...firstFailureByHead.values()].map((check) => ({
    pr: pr.number,
    headSha: check.headSha,
    check,
    fixedBy: passes.find(
      (p) =>
        p.headSha !== check.headSha &&
        (p.completedAt as Date).getTime() >
          (check.completedAt as Date).getTime() &&
        (p.completedAt as Date).getTime() < to.getTime()
    ),
  }));
}

// ---------------------------------------------------------------------------------------------
// Source reads
// ---------------------------------------------------------------------------------------------

const unknownSample = (
  reason: NonNullable<MetricSample["reason"]>,
  sourceWatermarks: MetricSample["sourceWatermarks"],
  evidenceRefs: string[]
): MetricSample => ({
  value: 0,
  unit: "ratio",
  complete: false,
  reason,
  sourceWatermarks,
  evidenceRefs,
});

interface PrRead {
  readonly prs: ReviewPrFacts[];
  /** More PRs than the budget, or a PR whose commits/checks did not fit. */
  readonly truncated: boolean;
  readonly asOf: Date;
}

/** Page through the source until it is exhausted or the page budget is spent. */
async function readPullRequests(
  ctx: Parameters<MetricCalculator["compute"]>[1],
  source: ReviewKpiSourcePort,
  repo: ReviewKpiRepo,
  selector: ReviewPrSelector
): Promise<PrRead> {
  const prs: ReviewPrFacts[] = [];
  const seen = new Set<number>();
  let cursor: string | undefined;
  let asOf = new Date(0);
  let more = true;
  for (let page = 0; page < MAX_REVIEW_PAGES && more; page++) {
    const read = await ctx.read((signal) =>
      source.pullRequestPage({
        repo,
        selector,
        cursor,
        pageSize: REVIEW_PAGE_SIZE,
        signal,
      })
    );
    for (const pr of read.prs) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      prs.push(pr);
    }
    asOf = read.asOf;
    cursor = read.nextCursor;
    more = cursor !== undefined;
  }
  return {
    prs,
    truncated: more || prs.some((p) => p.incomplete),
    asOf,
  };
}

const repoRef = (repo: ReviewKpiRepo) => `repo:${repo.owner}/${repo.repo}`;
const windowRef = (from: Date, to: Date) =>
  `window:${from.toISOString()}..${to.toISOString()}`;
const ratio = (n: number, d: number) => Math.round((10_000 * n) / d) / 10_000;

// ---------------------------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------------------------

export interface ReviewCalculatorOptions {
  /** The operator's parent repo (`NODE_SUBMODULE_PARENT_OWNER/REPO`). Undefined = not configured. */
  readonly repo: ReviewKpiRepo | undefined;
}

export function createReviewCalculators(
  source: ReviewKpiSourcePort,
  options: ReviewCalculatorOptions
): MetricCalculator[] {
  const params = z.strictObject({ days: daysSchema });
  const windowOf = (ctx: Parameters<MetricCalculator["compute"]>[1]) => ({
    from: new Date(ctx.window.start),
    to: new Date(ctx.window.end),
  });
  const notConfigured = () =>
    unknownSample("source_failed", [], ["review:not_configured:no_repo"]);

  // ---- KPI 1: merge coverage -----------------------------------------------------------------
  const mergeCoverage: MetricCalculator = {
    id: MERGE_COVERAGE_ID,
    historicalWindows: true,
    unit: "ratio",
    display: "progress",
    windowSeconds: (p) => params.parse(p).days * (DAY_MS / 1000),
    paramsSchema: params,
    budget: reviewBudget,
    async compute(raw, ctx) {
      params.parse(raw);
      const repo = options.repo;
      if (!repo) return notConfigured();
      const { from, to } = windowOf(ctx);
      const read = await readPullRequests(ctx, source, repo, {
        kind: "merged",
        from,
        to,
      });
      const watermarks = [
        { source: "github_pull_requests", asOf: read.asOf.toISOString() },
      ];
      const merged = read.prs.filter(
        (p) => p.mergedAt && within(p.mergedAt, from, to)
      );
      const verdicts = merged.map((pr) => ({
        pr,
        verdict: classifyMerge(pr, pr.mergedAt as Date),
      }));
      const covered = verdicts.filter((v) => v.verdict.covered);
      const evidence = [
        repoRef(repo),
        windowRef(from, to),
        `review:merged=${merged.length},covered=${covered.length}`,
        ...covered.slice(0, MAX_EVIDENCE).map(({ pr, verdict }) => {
          const c = (verdict as { check: ReviewCheckFacts }).check;
          return `covered:pr=${pr.number},check=${c.id},sha=${short(c.headSha)}`;
        }),
        ...verdicts
          .filter((v) => !v.verdict.covered)
          .slice(0, MAX_EVIDENCE)
          .map(
            ({ pr, verdict }) =>
              `uncovered:pr=${pr.number},reason=${(verdict as { reason: string }).reason}`
          ),
      ];
      if (read.truncated)
        return unknownSample(
          "incomplete_or_invalid_source",
          watermarks,
          evidence
        );
      if (merged.length === 0)
        return unknownSample("zero_denominator", watermarks, evidence);
      return {
        value: ratio(covered.length, merged.length),
        unit: "ratio",
        complete: true,
        sourceWatermarks: watermarks,
        evidenceRefs: evidence,
      };
    },
  };

  // ---- KPI 2: fail -> fix rate ---------------------------------------------------------------
  const failFixRate: MetricCalculator = {
    id: FAIL_FIX_RATE_ID,
    historicalWindows: true,
    unit: "ratio",
    display: "progress",
    windowSeconds: (p) => params.parse(p).days * (DAY_MS / 1000),
    paramsSchema: params,
    budget: reviewBudget,
    async compute(raw, ctx) {
      params.parse(raw);
      const repo = options.repo;
      if (!repo) return notConfigured();
      const { from, to } = windowOf(ctx);
      const read = await readPullRequests(ctx, source, repo, {
        kind: "updated",
        since: new Date(from.getTime() - UPDATED_LOOKBACK_MS),
      });
      const watermarks = [
        { source: "github_pull_requests", asOf: read.asOf.toISOString() },
      ];
      const failed = read.prs.flatMap((pr) => classifyFailures(pr, from, to));
      const fixed = failed.filter((f) => f.fixedBy);
      const evidence = [
        repoRef(repo),
        windowRef(from, to),
        `review:failed=${failed.length},fixed=${fixed.length}`,
        ...fixed
          .slice(0, MAX_EVIDENCE)
          .map(
            (f) =>
              `fixed:pr=${f.pr},failed_check=${f.check.id},failed_sha=${short(f.headSha)},fixed_check=${(f.fixedBy as ReviewCheckFacts).id},fixed_sha=${short((f.fixedBy as ReviewCheckFacts).headSha)}`
          ),
        ...failed
          .filter((f) => !f.fixedBy)
          .slice(0, MAX_EVIDENCE)
          .map(
            (f) =>
              `unfixed:pr=${f.pr},check=${f.check.id},sha=${short(f.headSha)}`
          ),
      ];
      if (read.truncated)
        return unknownSample(
          "incomplete_or_invalid_source",
          watermarks,
          evidence
        );
      if (failed.length === 0)
        return unknownSample("zero_denominator", watermarks, evidence);
      return {
        value: ratio(fixed.length, failed.length),
        unit: "ratio",
        complete: true,
        sourceWatermarks: watermarks,
        evidenceRefs: evidence,
      };
    },
  };

  return [mergeCoverage, failFixRate];
}
