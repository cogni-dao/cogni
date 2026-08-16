// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/github-vcs-merge-pr`
 * Purpose: Unit-cover the queue-tolerant `mergePr` branching — direct merge when the
 *   base branch requires no merge queue, enqueue (auto-merge) when it does.
 * Scope: Mocked Octokit (`request` + `graphql`) + `fetch`; no real GitHub I/O.
 * Invariants: MERGED_XOR_ENQUEUED — exactly one of `merged` | `enqueued` is set.
 * Side-effects: none
 * Links: src/adapters/server/vcs/github-vcs.adapter.ts, docs/spec/merge-authority.md
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type RequestHandler = (
  route: string,
  params: Record<string, unknown>
) => Promise<unknown> | unknown;
type GraphqlHandler = (
  query: string,
  vars: Record<string, unknown>
) => Promise<unknown> | unknown;

let onRequest: RequestHandler;
let onGraphql: GraphqlHandler;
const requestRoutes: string[] = [];
const graphqlQueries: string[] = [];

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "app-token" }),
}));

vi.mock("@octokit/core", () => ({
  Octokit: class MockOctokit {
    async request(route: string, params: Record<string, unknown>) {
      requestRoutes.push(route);
      return { data: await onRequest(route, params) };
    }
    async graphql(query: string, vars: Record<string, unknown>) {
      graphqlQueries.push(query);
      return onGraphql(query, vars);
    }
  },
}));

import { GitHubVcsAdapter } from "@/adapters/server/vcs/github-vcs.adapter";

function adapter(): GitHubVcsAdapter {
  return new GitHubVcsAdapter({ appId: "1", privateKey: "k" });
}

const PR_GET_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const MERGE_ROUTE = "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge";
const CHECK_RUNS_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}/check-runs";
const STATUS_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}/status";
const REVIEWS_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const CLASSIC_REQUIRED_CHECKS_ROUTE =
  "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks";
const ACTIVE_BRANCH_RULES_ROUTE =
  "GET /repos/{owner}/{repo}/rules/branches/{branch}";

beforeEach(() => {
  requestRoutes.length = 0;
  graphqlQueries.length = 0;
  // Installation lookup goes through global fetch.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 42 }),
    }))
  );
  onRequest = (route) => {
    if (route === PR_GET_ROUTE) {
      return { base: { ref: "main" }, node_id: "PR_node_1" };
    }
    throw new Error(`Unhandled request route: ${route}`);
  };
  onGraphql = () => ({ repository: { mergeQueue: null } });
});

describe("GitHubVcsAdapter.mergePr — queue-tolerant", () => {
  it("direct-merges (returns sha) when the base branch has no merge queue", async () => {
    onGraphql = () => ({ repository: { mergeQueue: null } });
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        return { base: { ref: "main" }, node_id: "PR_node_1" };
      }
      if (route === MERGE_ROUTE) {
        return { merged: true, sha: "deadbeef", message: "Merged" };
      }
      throw new Error(`Unhandled request route: ${route}`);
    };

    const result = await adapter().mergePr({
      owner: "o",
      repo: "r",
      prNumber: 7,
      method: "squash",
    });

    expect(result.merged).toBe(true);
    expect(result.enqueued).toBe(false);
    expect(result.sha).toBe("deadbeef");
    expect(requestRoutes).toContain(MERGE_ROUTE);
  });

  it("enqueues via auto-merge (no sha) when the base branch requires a queue", async () => {
    onGraphql = (query) => {
      if (query.includes("mergeQueue")) {
        return { repository: { mergeQueue: { id: "MQ_1" } } };
      }
      return {
        enablePullRequestAutoMerge: { pullRequest: { id: "PR_node_1" } },
      };
    };
    // Direct merge must NOT be attempted under a required queue.
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        return { base: { ref: "main" }, node_id: "PR_node_1" };
      }
      throw new Error(
        `Unexpected request route under a required queue: ${route}`
      );
    };

    const result = await adapter().mergePr({
      owner: "o",
      repo: "r",
      prNumber: 7,
      method: "squash",
    });

    expect(result.enqueued).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.sha).toBeUndefined();
    expect(requestRoutes).not.toContain(MERGE_ROUTE);
    // queue-detect + enable-auto-merge both ran.
    expect(graphqlQueries.length).toBe(2);
  });

  it("surfaces a 405 as a structured failure (neither merged nor enqueued)", async () => {
    onGraphql = () => ({ repository: { mergeQueue: null } });
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        return { base: { ref: "main" }, node_id: "PR_node_1" };
      }
      if (route === MERGE_ROUTE) {
        throw Object.assign(new Error("not mergeable"), { status: 405 });
      }
      throw new Error(`Unhandled request route: ${route}`);
    };

    const result = await adapter().mergePr({
      owner: "o",
      repo: "r",
      prNumber: 7,
      method: "squash",
    });

    expect(result.merged).toBe(false);
    expect(result.enqueued).toBe(false);
    expect(result.status).toBe(405);
  });
});

describe("GitHubVcsAdapter.getCiStatus — ruleset-required checks", () => {
  function installCiHandlers(completedContexts: readonly string[]): void {
    onRequest = (route, params) => {
      if (route === PR_GET_ROUTE) {
        return {
          number: 7,
          title: "feat: protected change",
          user: { login: "agent" },
          base: { ref: "main" },
          head: { sha: "head-sha" },
          mergeable: true,
          labels: [],
          draft: false,
        };
      }
      if (route === CHECK_RUNS_ROUTE) {
        return {
          check_runs: completedContexts.map((name) => ({
            name,
            status: "completed",
            conclusion: "success",
            app: { slug: "github-actions" },
          })),
        };
      }
      if (route === STATUS_ROUTE) return { statuses: [] };
      if (route === REVIEWS_ROUTE) return [];
      if (route === CLASSIC_REQUIRED_CHECKS_ROUTE) {
        throw Object.assign(new Error("Branch not protected"), { status: 404 });
      }
      if (route === ACTIVE_BRANCH_RULES_ROUTE) {
        expect(params).toMatchObject({ branch: "main", per_page: 100 });
        return [
          {
            type: "pull_request",
            ruleset_id: 1,
          },
          {
            type: "required_status_checks",
            ruleset_id: 1,
            parameters: {
              required_status_checks: [
                { context: "unit" },
                { context: "component" },
                { context: "static" },
                { context: "manifest" },
              ],
              strict_required_status_checks_policy: false,
            },
          },
        ];
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
  }

  it("is not vacuously green when one ruleset-required check never reported", async () => {
    installCiHandlers(["unit", "component", "static"]);

    const result = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 7,
    });

    expect(result.allGreen).toBe(false);
    expect(result.pending).toBe(true);
    expect(requestRoutes).toContain(ACTIVE_BRANCH_RULES_ROUTE);
  });

  it("is green only after every ruleset-required check reports success", async () => {
    installCiHandlers(["unit", "component", "static", "manifest"]);

    const result = await adapter().getCiStatus({
      owner: "o",
      repo: "r",
      prNumber: 7,
    });

    expect(result.allGreen).toBe(true);
    expect(result.pending).toBe(false);
  });
});
