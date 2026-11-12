// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/review/review-kpi-source.adapter.test`
 * Purpose: Prove the GraphQL mapping and search strings of the review KPI source (task.5450): GitHub's
 *   upper-case enums become lowercase facts, anything that did not fit is `incomplete`, the repo is
 *   validated before it joins a search, and a page maps to port facts with its cursor.
 * Side-effects: none
 */

import type { WorkflowClient } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubReviewKpiSource,
  type GraphqlFn,
  mapPullRequestNode,
  readTemporalReviewHeads,
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
  it("missing or invalid check identities make mixed reads incomplete", () => {
    for (const databaseId of [
      null,
      Number.NaN,
      0,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const mapped = mapPullRequestNode(node({}, [run(), run({ databaseId })]));
      expect(mapped).toMatchObject({ incomplete: true, checks: [{ id: 7 }] });
      expect(mapped?.checks).toHaveLength(1);
    }
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
      expect(query).toContain("checkType: ALL");
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

describe("duration source discovery", () => {
  const repo = { owner: "cogni-dao", repo: "cogni" };
  const to = new Date("2026-11-12T12:00:00Z");
  const from = new Date("2026-11-11T12:00:00Z");
  const input = { repo, from, to, signal: new AbortController().signal };
  const id = `pr-review:cogni-dao/cogni/3144/${SHA}`;
  function client(ids: string[], retentionSeconds = 30 * 86400) {
    const queries: string[] = [];
    const native = {
      options: { namespace: "operator" },
      connection: {
        withAbortSignal: vi.fn(async (_signal, fn: () => Promise<unknown>) =>
          fn()
        ),
        workflowService: {
          describeNamespace: vi.fn(async () => ({
            config: {
              workflowExecutionRetentionTtl: { seconds: retentionSeconds },
            },
          })),
        },
      },
      list: ({ query }: { query: string }) => {
        queries.push(query);
        return (async function* () {
          for (const workflowId of ids) yield { workflowId };
        })();
      },
    };
    return { native, queries, sdk: native as unknown as WorkflowClient };
  }
  it("uses durable review heads even after rebase and deduplicates workflow reruns", async () => {
    const c = client([id, id]);
    expect(await readTemporalReviewHeads(c.sdk, input, to)).toMatchObject({
      incomplete: false,
      heads: [{ pr: 3144, headSha: SHA }],
    });
    expect(c.queries[0]).toContain(
      "WorkflowId STARTS_WITH 'pr-review:cogni-dao/cogni/'"
    );
    expect(c.queries[0]).toContain(
      `CloseTime >= '${from.toISOString()}' OR ExecutionStatus = 'Running'`
    );
    expect(c.queries[0]).not.toContain("CloseTime <");
    expect(c.native.connection.withAbortSignal).toHaveBeenCalledWith(
      input.signal,
      expect.any(Function)
    );
  });
  it("marks insufficient native retention, invalid IDs and budget overflow incomplete", async () => {
    for (const c of [
      client([id], 3600),
      client([`${id}/bad`]),
      client(Array(301).fill(id)),
      client(
        Array.from(
          { length: 51 },
          (_, i) =>
            `pr-review:cogni-dao/cogni/3144/${i.toString(16).padStart(40, "0")}`
        )
      ),
    ]) {
      expect(await readTemporalReviewHeads(c.sdk, input, to)).toMatchObject({
        incomplete: true,
      });
    }
  });
  it("reads ALL App checks directly at the pinned head without a mutable PR query", async () => {
    const graphql: GraphqlFn = async (query, vars) => {
      expect(query).toContain("object(oid: $sha)");
      expect(query).toContain("checkType: ALL");
      expect(vars).toMatchObject({
        owner: repo.owner,
        repo: repo.repo,
        sha: SHA,
        appId: 2994706,
      });
      return {
        repository: { object: node().commits.nodes[0]?.commit ?? null },
      };
    };
    const source = new GitHubReviewKpiSource(
      {
        appId: "2994706",
        privateKeyBase64: "",
        checkName: "Cogni Git PR Review",
      },
      () => to,
      graphql
    );
    expect(
      await source.readHeadChecks({ repo, headSha: SHA, signal: input.signal })
    ).toMatchObject({
      incomplete: false,
      checks: [{ id: 7, startedAt: new Date("2026-11-06T09:56:00Z") }],
    });
    await expect(source.readReviewHeads(input)).rejects.toThrow(
      "review_duration_visibility_unavailable"
    );
  });
});
