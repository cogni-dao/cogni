// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/review/review-kpi-source.adapter.test`
 * Purpose: Prove the GraphQL mapping and search strings of the review KPI source (task.5450): GitHub's
 *   upper-case enums become lowercase facts, anything that did not fit is `incomplete`, the repo is
 *   validated before it joins a search, and a page maps to port facts with its cursor.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import {
  GitHubReviewKpiSource,
  type GraphqlFn,
  mapPullRequestNode,
  searchQueryFor,
} from "./review-kpi-source.adapter";

const SHA = "a".repeat(40);
const run = (over: object = {}) => ({
  databaseId: 7,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  startedAt: "2026-11-06T09:56:00Z",
  completedAt: "2026-11-06T10:00:00Z",
  ...over,
});
const node = (over: object = {}, runs = [run()]) => ({
  number: 3066,
  mergedAt: "2026-11-06T11:00:00Z",
  headRefOid: SHA,
  commits: {
    totalCount: 1,
    nodes: [
      {
        commit: {
          oid: SHA,
          checkSuites: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                checkRuns: { pageInfo: { hasNextPage: false }, nodes: runs },
              },
            ],
          },
        },
      },
    ],
  },
  ...over,
});

describe("mapPullRequestNode", () => {
  it("lowercases GitHub enums and keeps the commit each check ran on", () => {
    expect(mapPullRequestNode(node())).toEqual({
      number: 3066,
      mergedAt: new Date("2026-11-06T11:00:00Z"),
      headSha: SHA,
      incomplete: false,
      checks: [
        {
          id: 7,
          headSha: SHA,
          status: "completed",
          conclusion: "success",
          startedAt: new Date("2026-11-06T09:56:00Z"),
          completedAt: new Date("2026-11-06T10:00:00Z"),
        },
      ],
    });
  });
  it("an unfinished check has no conclusion or completion time", () => {
    const f = mapPullRequestNode(
      node({}, [
        run({ status: "IN_PROGRESS", conclusion: null, completedAt: null }),
      ])
    );
    expect(f?.checks[0]).toMatchObject({
      status: "in_progress",
      conclusion: undefined,
      completedAt: undefined,
    });
  });
  it("more commits, suites or check runs than were read make the PR incomplete", () => {
    const base = node();
    expect(
      mapPullRequestNode({
        ...base,
        commits: { ...base.commits, totalCount: 101 },
      })?.incomplete
    ).toBe(true);
    const runsMore = node();
    (
      runsMore.commits.nodes[0] as {
        commit: { checkSuites: { nodes: Array<{ checkRuns: object }> } };
      }
    ).commit.checkSuites.nodes[0] = {
      checkRuns: { pageInfo: { hasNextPage: true }, nodes: [run()] },
    };
    expect(mapPullRequestNode(runsMore)?.incomplete).toBe(true);
  });
  it("a search hit that is not a PR maps to nothing; a never-merged PR has no mergedAt", () => {
    expect(mapPullRequestNode({})).toBeUndefined();
    expect(mapPullRequestNode(null)).toBeUndefined();
    expect(mapPullRequestNode(node({ mergedAt: null }))?.mergedAt).toBe(
      undefined
    );
  });
});

describe("searchQueryFor", () => {
  const repo = { owner: "cogni-dao", repo: "cogni" };
  it("builds a merged range and an updated floor with stable ordering", () => {
    expect(
      searchQueryFor(repo, {
        kind: "merged",
        from: new Date("2026-10-31T12:00:00.000Z"),
        to: new Date("2026-11-07T12:00:00.000Z"),
      })
    ).toBe(
      "repo:cogni-dao/cogni is:pr is:merged merged:2026-10-31T12:00:00Z..2026-11-07T12:00:00Z sort:created-asc"
    );
    expect(
      searchQueryFor(repo, {
        kind: "updated",
        since: new Date("2026-10-30T12:00:00.000Z"),
      })
    ).toBe(
      "repo:cogni-dao/cogni is:pr updated:>=2026-10-30T12:00:00Z sort:created-asc"
    );
  });
  it("refuses a repo that could rewrite the search", () => {
    expect(() =>
      searchQueryFor(
        { owner: "cogni-dao", repo: "cogni is:open" },
        { kind: "updated", since: new Date(0) }
      )
    ).toThrow("review_kpi_repo_invalid");
  });
});

describe("GitHubReviewKpiSource", () => {
  const config = { appId: "2994706", privateKeyBase64: "", checkName: "X" };
  const repo = { owner: "cogni-dao", repo: "cogni" };
  const selector = { kind: "updated" as const, since: new Date(0) };
  it("maps a page, passes the App id and check name, and returns the next cursor", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const graphql: GraphqlFn = async (query, vars) => {
      expect(query).toContain("startedAt");
      seen.push(vars);
      return {
        search: {
          pageInfo: { hasNextPage: true, endCursor: "c1" },
          nodes: [node(), {}],
        },
      };
    };
    const asOf = new Date("2026-11-07T12:00:00Z");
    const src = new GitHubReviewKpiSource(config, () => asOf, graphql);
    const page = await src.pullRequestPage({
      repo,
      selector,
      cursor: undefined,
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(page.prs.map((p) => p.number)).toEqual([3066]);
    expect(page.nextCursor).toBe("c1");
    expect(page.asOf).toBe(asOf);
    expect(seen[0]).toMatchObject({
      appId: 2994706,
      check: "X",
      pageSize: 20,
      after: null,
    });
  });
  it("last page has no cursor; a non-numeric App id fails the read, not construction", async () => {
    const graphql: GraphqlFn = async () => ({
      search: { pageInfo: { hasNextPage: false, endCursor: "c9" }, nodes: [] },
    });
    const input = {
      repo,
      selector,
      cursor: "c1",
      pageSize: 20,
      signal: new AbortController().signal,
    };
    expect(
      (
        await new GitHubReviewKpiSource(
          config,
          undefined,
          graphql
        ).pullRequestPage(input)
      ).nextCursor
    ).toBeUndefined();
    await expect(
      new GitHubReviewKpiSource(
        { ...config, appId: "" },
        undefined,
        graphql
      ).pullRequestPage(input)
    ).rejects.toThrow("review_kpi_app_id_invalid");
  });
});
