// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/review-kpi`
 * Purpose: Read-only source for the operator's PR-review goal KPIs (task.5450): pull requests of the
 *   operator's parent repo with the review App's `Cogni Git PR Review` check runs on their commits.
 * Scope: Interfaces only. The GitHub adapter lives in `adapters/server/review/`; the calculators that
 *   consume these facts live in `features/review/review-kpis.ts`.
 * Invariants:
 *   - APP_WRITTEN_ONLY: every check fact is a check run that the review App itself wrote. Agent flags,
 *     PR text and comments never reach this port.
 *   - BOUNDED: a read is one page of at most `pageSize` PRs. `nextCursor` says more exist; a PR whose
 *     commits or check runs did not fit is `incomplete`, never silently dropped.
 *   - CONCLUSION_IS_GITHUB: `conclusion` is GitHub's lowercase check-run conclusion, unmapped.
 * Side-effects: none
 * Links: features/review/review-kpis.ts, adapters/server/review/review-kpi-source.adapter.ts, task.5450
 * @public
 */

/** The repository whose merges are measured (the operator's parent repo). */
export interface ReviewKpiRepo {
  readonly owner: string;
  readonly repo: string;
}

/** One check run the review App wrote on one commit of a PR. */
export interface ReviewCheckFacts {
  /** GitHub check-run id (`check_run.id`). */
  readonly id: number;
  /** The commit the check ran on. */
  readonly headSha: string;
  /** `completed` once a verdict exists; any other status has no conclusion yet. */
  readonly status: string;
  /** Lowercase GitHub conclusion (`success`, `failure`, `neutral`, ...); absent until completed. */
  readonly conclusion: string | undefined;
  /** GitHub's actual check start; absent timestamps cannot establish a duration. */
  readonly startedAt: Date | undefined;
  readonly completedAt: Date | undefined;
}

/** One PR with the review App's checks on the commits the read covered. */
export interface ReviewPrFacts {
  readonly number: number;
  /** Absent for a PR that was never merged. */
  readonly mergedAt: Date | undefined;
  /** The PR's current head commit (for a merged PR, the commit that merged). */
  readonly headSha: string;
  readonly checks: readonly ReviewCheckFacts[];
  /** More commits or check runs exist than this read returned: the PR is not fully known. */
  readonly incomplete: boolean;
}

/** Which PRs a page covers. Both forms are bounded by GitHub-side time filters. */
export type ReviewPrSelector =
  /** PRs merged in `[from, to)`. */
  | { readonly kind: "merged"; readonly from: Date; readonly to: Date }
  /** PRs touched at or after `since` (a failed review's PR may not have merged). */
  | { readonly kind: "updated"; readonly since: Date };

export interface ReviewKpiSourcePort {
  pullRequestPage(input: {
    readonly repo: ReviewKpiRepo;
    readonly selector: ReviewPrSelector;
    /** Opaque cursor from the previous page; absent for the first page. */
    readonly cursor: string | undefined;
    readonly pageSize: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly prs: readonly ReviewPrFacts[];
    /** Present when more pages exist. */
    readonly nextCursor: string | undefined;
    readonly asOf: Date;
  }>;
}
