// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/review/review-kpi-source.adapter`
 * Purpose: The PR-review goal-KPI source (task.5450): bounded read-only GitHub GraphQL reads of a repo's
 *   pull requests with the review App's `Cogni Git PR Review` check runs on their commits.
 * Scope: IO only. Classification and the calculators live in `features/review/review-kpis.ts`.
 *   Goal metrics, not telemetry: nothing here touches Prometheus (hub goal-metrics-vs-telemetry).
 * Invariants:
 *   - READ_ONLY: queries only; the review App's installation token is used for reads.
 *   - APP_WRITTEN_ONLY: check suites are filtered server-side by `filterBy: { appId }` with the
 *     operator's `GH_REVIEW_APP_ID`, and check runs by the exact check name. GitHub's data model puts
 *     each check run in exactly one suite owned by exactly one App, so nothing an agent writes
 *     (flags, PR text, comments, another App's check of the same name) can match.
 *   - BOUNDED: one call is one page of at most `pageSize` PRs (`last: 100` commits, 5 suites, 10 check runs
 *     each); anything that does not fit marks the PR `incomplete`, never drops it silently.
 *   - STABLE_PAGING: results sort by creation time ascending, so a PR updated mid-read does not move.
 *   - NO_HARDCODED_IDENTITY: the repo comes from the caller and the App id from operator env.
 * Side-effects: IO (outbound HTTPS to api.github.com)
 * Links: ports/review-kpi.port.ts, adapters/server/review/github-review.adapter.ts, task.5450
 * @internal
 */

import { createAppAuth } from "@octokit/auth-app";
import type {
  ReviewCheckFacts,
  ReviewKpiRepo,
  ReviewKpiSourcePort,
  ReviewPrFacts,
  ReviewPrSelector,
} from "@/ports";
import { createInstallationOctokit } from "./github-auth";

const REQUEST_TIMEOUT_MS = 15_000;
/** Newest commits read per PR; more is `incomplete`. */
const COMMITS_PER_PR = 100;
const SUITES_PER_COMMIT = 5;
const RUNS_PER_SUITE = 10;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

const QUERY = `query($q: String!, $after: String, $pageSize: Int!, $appId: Int!, $check: String!) {
  search(query: $q, type: ISSUE, first: $pageSize, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        mergedAt
        headRefOid
        commits(last: ${COMMITS_PER_PR}) {
          totalCount
          nodes {
            commit {
              oid
              checkSuites(first: ${SUITES_PER_COMMIT}, filterBy: { appId: $appId }) {
                pageInfo { hasNextPage }
                nodes {
                  checkRuns(first: ${RUNS_PER_SUITE}, filterBy: { checkName: $check }) {
                    pageInfo { hasNextPage }
                    nodes { databaseId status conclusion startedAt completedAt }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface CheckRunNode {
  databaseId: number | null;
  status: string | null;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface PullRequestNode {
  number?: number;
  mergedAt?: string | null;
  headRefOid?: string;
  commits?: {
    totalCount: number;
    nodes: Array<{
      commit: {
        oid: string;
        checkSuites: {
          pageInfo: { hasNextPage: boolean };
          nodes: Array<{
            checkRuns: {
              pageInfo: { hasNextPage: boolean };
              nodes: CheckRunNode[];
            };
          }>;
        };
      };
    }>;
  };
}

interface SearchResponse {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<PullRequestNode | null>;
  };
}

export type GraphqlFn = (
  query: string,
  variables: Record<string, unknown>
) => Promise<SearchResponse>;

/** Map one GraphQL PR node to port facts. Non-PR search hits (empty objects) return undefined. */
export function mapPullRequestNode(
  node: PullRequestNode | null
): ReviewPrFacts | undefined {
  if (!node || node.number === undefined || !node.headRefOid) return undefined;
  const checks: ReviewCheckFacts[] = [];
  let incomplete = false;
  const commits = node.commits;
  if (!commits || commits.totalCount > commits.nodes.length) incomplete = true;
  for (const { commit } of commits?.nodes ?? []) {
    if (commit.checkSuites.pageInfo.hasNextPage) incomplete = true;
    for (const suite of commit.checkSuites.nodes) {
      if (suite.checkRuns.pageInfo.hasNextPage) incomplete = true;
      for (const run of suite.checkRuns.nodes) {
        if (run.databaseId === null) continue;
        checks.push({
          id: run.databaseId,
          headSha: commit.oid,
          status: (run.status ?? "").toLowerCase(),
          conclusion: run.conclusion ? run.conclusion.toLowerCase() : undefined,
          startedAt: run.startedAt ? new Date(run.startedAt) : undefined,
          completedAt: run.completedAt ? new Date(run.completedAt) : undefined,
        });
      }
    }
  }
  return {
    number: node.number,
    mergedAt: node.mergedAt ? new Date(node.mergedAt) : undefined,
    headSha: node.headRefOid,
    checks,
    incomplete,
  };
}

const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** GitHub search string for a selector; the repo is validated before it joins a query. */
export function searchQueryFor(
  repo: ReviewKpiRepo,
  selector: ReviewPrSelector
): string {
  if (!SAFE_NAME.test(repo.owner) || !SAFE_NAME.test(repo.repo))
    throw new Error("review_kpi_repo_invalid");
  const base = `repo:${repo.owner}/${repo.repo} is:pr`;
  return selector.kind === "merged"
    ? `${base} is:merged merged:${isoSeconds(selector.from)}..${isoSeconds(selector.to)} sort:created-asc`
    : `${base} updated:>=${isoSeconds(selector.since)} sort:created-asc`;
}

export interface GitHubReviewKpiSourceConfig {
  /** The review App (`GH_REVIEW_APP_ID`): its id is the only identity a check may carry. */
  readonly appId: string;
  readonly privateKeyBase64: string;
  /** Exact check-run name the review App writes. */
  readonly checkName: string;
}

export class GitHubReviewKpiSource implements ReviewKpiSourcePort {
  private readonly graphqlByRepo = new Map<string, GraphqlFn>();

  constructor(
    private readonly config: GitHubReviewKpiSourceConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly graphqlOverride?: GraphqlFn
  ) {}

  /** Resolve the review App's installation on the repo, then keep one token-caching client per repo. */
  private async graphqlFor(
    repo: ReviewKpiRepo,
    signal: AbortSignal
  ): Promise<GraphqlFn> {
    if (this.graphqlOverride) return this.graphqlOverride;
    const key = `${repo.owner}/${repo.repo}`;
    const cached = this.graphqlByRepo.get(key);
    if (cached) return cached;
    const privateKey = Buffer.from(
      this.config.privateKeyBase64,
      "base64"
    ).toString("utf-8");
    const { token } = await createAppAuth({
      appId: this.config.appId,
      privateKey,
    })({ type: "app" });
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/installation`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      }
    );
    if (!response.ok)
      throw new Error(
        `review App not installed on ${key} (HTTP ${response.status})`
      );
    const installationId = ((await response.json()) as { id: number }).id;
    const octokit = createInstallationOctokit(
      installationId,
      this.config.appId,
      this.config.privateKeyBase64,
      REQUEST_TIMEOUT_MS
    );
    const graphql: GraphqlFn = (query, variables) =>
      octokit.graphql<SearchResponse>(query, variables);
    this.graphqlByRepo.set(key, graphql);
    return graphql;
  }

  async pullRequestPage(input: {
    readonly repo: ReviewKpiRepo;
    readonly selector: ReviewPrSelector;
    readonly cursor: string | undefined;
    readonly pageSize: number;
    readonly signal: AbortSignal;
  }) {
    input.signal.throwIfAborted();
    // Validated per read, not at construction: a bad value fails one metric, never container boot.
    if (this.config.checkName.trim() === "")
      throw new Error("review_kpi_check_name_invalid");
    if (!/^\d+$/.test(this.config.appId))
      throw new Error("review_kpi_app_id_invalid");
    const graphql = await this.graphqlFor(input.repo, input.signal);
    const data = await graphql(QUERY, {
      q: searchQueryFor(input.repo, input.selector),
      after: input.cursor ?? null,
      pageSize: input.pageSize,
      appId: Number(this.config.appId),
      check: this.config.checkName,
      request: { signal: input.signal },
    });
    input.signal.throwIfAborted();
    const prs = data.search.nodes
      .map(mapPullRequestNode)
      .filter((p): p is ReviewPrFacts => p !== undefined);
    const { hasNextPage, endCursor } = data.search.pageInfo;
    return {
      prs,
      nextCursor: hasNextPage && endCursor ? endCursor : undefined,
      asOf: this.clock(),
    };
  }
}
