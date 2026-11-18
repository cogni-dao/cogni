// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/candidate-backlog`
 * Purpose: Read-only source for the candidate backlog KPI (task.5498): a node repo's open, non-draft pull
 *   requests with their head SHAs, and when each head SHA's CI went green.
 * Scope: Interfaces only. The GitHub adapter lives in `adapters/server/review/`; the calculators live in
 *   `features/node-deploy/candidate-backlog-kpis.ts`.
 * Invariants:
 *   - READ_ONLY: queries only, through the operator's existing GitHub App installation.
 *   - BOUNDED: one PR list read of at most `maxPrs` and one check-suites read per head SHA.
 *   - TRUNCATION_IS_REPORTED: more open PRs than `maxPrs`, or more check suites than one read returns, is a flag,
 *     never a silent drop.
 * Side-effects: none
 * Links: features/node-deploy/candidate-backlog-kpis.ts, adapters/server/review/candidate-backlog-source.adapter.ts
 * @public
 */

/** The node's repository (from its catalog `source_repo`). */
export interface CandidateRepo {
  readonly owner: string;
  readonly repo: string;
}

/** One open, non-draft pull request. */
export interface CandidateOpenPr {
  readonly number: number;
  /** The PR's current head commit. */
  readonly headSha: string;
  readonly createdAt: Date;
}

export interface CandidateBacklogSourcePort {
  /** Open non-draft PRs, at most `maxPrs`. `truncated` when more open PRs exist than one read covers. */
  openPullRequests(input: {
    readonly repo: CandidateRepo;
    readonly maxPrs: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly prs: readonly CandidateOpenPr[];
    readonly truncated: boolean;
    readonly asOf: Date;
  }>;
  /**
   * When the head SHA's CI went green: every check suite completed with `success`, `neutral` or `skipped`, at the
   * latest suite completion. `green` is undefined while CI is pending, failed or absent. `incomplete` is true when
   * more suites exist than the read returned (the SHA is not fully known).
   */
  ciGreenAt(input: {
    readonly repo: CandidateRepo;
    readonly headSha: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly green: Date | undefined;
    readonly incomplete: boolean;
  }>;
}
