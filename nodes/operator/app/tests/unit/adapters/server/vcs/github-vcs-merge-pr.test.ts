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
