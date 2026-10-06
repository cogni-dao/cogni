// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/github-vcs-merge-pr`
 * Purpose: Unit-cover the `mergePr` branching — direct merge when the base branch requires no
 *   queue, enqueue when it does, and the explicitly authorized direct-merge bypass.
 * Scope: Mocked Octokit (`request` + `graphql`) + `fetch`; no real GitHub I/O.
 * Invariants: MERGED_XOR_ENQUEUED — exactly one of `merged` | `enqueued` is set.
 * Side-effects: none
 * Links: src/adapters/server/vcs/github-vcs.adapter.ts, docs/spec/merge-authority.md
 * @internal
 */

import { createHash } from "node:crypto";
import { renderDeploymentActivationSpec } from "@cogni/repo-spec";
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
const requestParams: Record<string, unknown>[] = [];
const graphqlQueries: string[] = [];

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "app-token" }),
}));

vi.mock("@octokit/core", () => ({
  Octokit: class MockOctokit {
    async request(route: string, params: Record<string, unknown>) {
      requestRoutes.push(route);
      requestParams.push(params);
      return { data: await onRequest(route, params), headers: {} };
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
const COMMIT_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}";
const UPDATE_REF_ROUTE = "PATCH /repos/{owner}/{repo}/git/refs/{ref}";
const REVIEWS_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const CLASSIC_REQUIRED_CHECKS_ROUTE =
  "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks";
const ACTIVE_BRANCH_RULES_ROUTE =
  "GET /repos/{owner}/{repo}/rules/branches/{branch}";
const CONTENTS_ROUTE = "GET /repos/{owner}/{repo}/contents/{path}";
const PR_FILES_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/files";

beforeEach(() => {
  requestRoutes.length = 0;
  requestParams.length = 0;
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
      expectedHeadSha: "verified-head-sha",
    });

    expect(result.merged).toBe(true);
    expect(result.enqueued).toBe(false);
    expect(result.sha).toBe("deadbeef");
    expect(requestRoutes).toContain(MERGE_ROUTE);
    expect(requestParams.at(-1)).toMatchObject({
      merge_method: "squash",
      sha: "verified-head-sha",
    });
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
      expectedHeadSha: "verified-head-sha",
    });

    expect(result.enqueued).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.sha).toBeUndefined();
    expect(requestRoutes).not.toContain(MERGE_ROUTE);
    // queue-detect + enable-auto-merge both ran.
    expect(graphqlQueries.length).toBe(2);
  });

  it("never direct-merges when merge-queue discovery fails", async () => {
    onGraphql = () => {
      throw new Error("GraphQL unavailable");
    };
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        return { base: { ref: "main" }, node_id: "PR_node_1" };
      }
      throw new Error(`Unexpected REST request: ${route}`);
    };

    const result = await adapter().mergePr({
      owner: "o",
      repo: "r",
      prNumber: 7,
      method: "squash",
      expectedHeadSha: "verified-head-sha",
    });

    expect(result).toMatchObject({ merged: false, enqueued: false });
    expect(requestRoutes).not.toContain(MERGE_ROUTE);
    expect(graphqlQueries).toHaveLength(1);
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
      expectedHeadSha: "verified-head-sha",
    });

    expect(result.merged).toBe(false);
    expect(result.enqueued).toBe(false);
    expect(result.status).toBe(405);
  });

  it("fails closed when GitHub rejects a changed head SHA", async () => {
    onRequest = (route, params) => {
      if (route === PR_GET_ROUTE) {
        return { base: { ref: "main" }, node_id: "PR_node_1" };
      }
      if (route === MERGE_ROUTE) {
        expect(params).toMatchObject({ sha: "verified-head-sha" });
        throw Object.assign(new Error("Head branch was modified"), {
          status: 409,
        });
      }
      throw new Error(`Unhandled request route: ${route}`);
    };

    const result = await adapter().mergePr({
      owner: "o",
      repo: "r",
      prNumber: 7,
      method: "squash",
      expectedHeadSha: "verified-head-sha",
    });

    expect(result).toMatchObject({
      merged: false,
      enqueued: false,
      status: 409,
    });
  });
});

describe("GitHubVcsAdapter.verifyOperatorChange — dynamic parent catalog", () => {
  it("re-reads protected parent main and rejects a source_repo changed after an earlier proof", async () => {
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    const node = "blue";
    const repository = "o/blue";
    const path = ".cogni/repo-spec.yaml";
    const pathHash = createHash("sha256").update(`${path}\n`).digest("hex");
    const baseSpec = `schema_version: "0.1.4"
node_id: "11111111-1111-4111-8111-111111111111"
scope_id: "22222222-2222-4222-8222-222222222222"
scope_key: "default"
intent:
  name: blue
  mission: "catalog race fixture"
governance:
  dao_contract: "0x1111111111111111111111111111111111111111"
  chain_id: "8453"
`;
    const headSpec = renderDeploymentActivationSpec(baseSpec);
    const message = `feat(deploy): declare blue node deployment

Cogni-Change-Type: cogni.operator-change.v1
Cogni-Operation: deployment.declare
Cogni-Node: blue
Cogni-Base-SHA: ${baseSha}
Cogni-Changed-Paths-SHA256: ${pathHash}`;
    const registry = {
      version: "cogni.operator-change.v1",
      repositories: {},
      childRepositoryApps: {
        o: { botLogin: "operator[bot]", botId: 10 },
      },
      operations: {
        "env.membership": { enabledRepositories: [], verifier: "disabled" },
        "env.placement": { enabledRepositories: [], verifier: "disabled" },
        "env.region": { enabledRepositories: [], verifier: "disabled" },
        "node.register": { enabledRepositories: [], verifier: "disabled" },
        "deployment.declare": {
          enabledRepositories: [],
          enabledChildOwners: ["o"],
          verifier: "scripts/ci/verifiers/verify-operator-change.sh",
        },
      },
    };
    let currentCatalog =
      "name: blue\nsource_repo: https://github.com/o/blue.git\n";
    let catalogReads = 0;
    const encode = (value: string) => Buffer.from(value).toString("base64");
    onRequest = (route, params) => {
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          base: { ref: "main", sha: baseSha },
          head: {
            ref: "cogni-operator/declare-deployment-blue",
            sha: headSha,
            repo: { full_name: repository },
          },
          user: { login: "operator[bot]", id: 10, type: "Bot" },
          commits: 1,
        };
      }
      if (route === COMMIT_ROUTE) {
        return {
          sha: headSha,
          author: { login: "operator[bot]", id: 10 },
          parents: [{ sha: baseSha }],
          commit: {
            message,
            verification: { verified: true, reason: "valid" },
          },
        };
      }
      if (route === PR_FILES_ROUTE) {
        return [
          { filename: path, previous_filename: null, status: "modified" },
        ];
      }
      if (route === CONTENTS_ROUTE) {
        if (params.path === "scripts/ci/operator-change-v1.allowlist.json") {
          return {
            type: "file",
            content: encode(JSON.stringify(registry)),
          };
        }
        if (params.path === "infra/catalog/blue.yaml") {
          catalogReads += 1;
          return { type: "file", content: encode(currentCatalog) };
        }
        if (params.path === path) {
          return {
            type: "file",
            content: encode(params.ref === headSha ? headSpec : baseSpec),
          };
        }
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    const vcs = new GitHubVcsAdapter({
      appId: "1",
      privateKey: "k",
      operatorChangePolicyOwner: "parent",
      operatorChangePolicyRepo: "control",
    });

    await expect(
      vcs.verifyOperatorChange({
        owner: "o",
        repo: node,
        prNumber: 42,
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({ eligible: true, reason: "eligible" });

    currentCatalog =
      "name: blue\nsource_repo: https://github.com/o/not-blue.git\n";
    await expect(
      vcs.verifyOperatorChange({
        owner: "o",
        repo: node,
        prNumber: 42,
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({
      eligible: false,
      reason: "operation-replay-failed",
    });
    expect(catalogReads).toBe(2);
  });
});

describe("GitHubVcsAdapter.fastForwardOperatorChange — base+head CAS", () => {
  const baseSha = "b".repeat(40);
  const headSha = "a".repeat(40);

  it("non-force fast-forwards the verified one-parent head", async () => {
    onRequest = (route, params) => {
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          base: { ref: "main", sha: baseSha },
          head: { sha: headSha, repo: { full_name: "o/r" } },
        };
      }
      if (route === COMMIT_ROUTE) {
        return { sha: headSha, parents: [{ sha: baseSha }] };
      }
      if (route === UPDATE_REF_ROUTE) {
        expect(params).toMatchObject({
          ref: "heads/main",
          sha: headSha,
          force: false,
        });
        return { object: { sha: headSha } };
      }
      throw new Error(`Unhandled request route: ${route}`);
    };

    const result = await adapter().fastForwardOperatorChange({
      owner: "o",
      repo: "r",
      prNumber: 7,
      expectedBaseSha: baseSha,
      expectedHeadSha: headSha,
    });

    expect(result).toMatchObject({
      merged: true,
      enqueued: false,
      sha: headSha,
    });
  });

  it("rejects stale PR base/head facts before updating the ref", async () => {
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          base: { ref: "main", sha: "c".repeat(40) },
          head: { sha: headSha, repo: { full_name: "o/r" } },
        };
      }
      if (route === COMMIT_ROUTE) {
        return { sha: headSha, parents: [{ sha: baseSha }] };
      }
      throw new Error(`Unexpected request route: ${route}`);
    };

    const result = await adapter().fastForwardOperatorChange({
      owner: "o",
      repo: "r",
      prNumber: 7,
      expectedBaseSha: baseSha,
      expectedHeadSha: headSha,
    });

    expect(result).toMatchObject({ merged: false, status: 409 });
    expect(requestRoutes).not.toContain(UPDATE_REF_ROUTE);
  });

  it("rejects a non-main base before updating the ref", async () => {
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          base: { ref: "release", sha: baseSha },
          head: { sha: headSha, repo: { full_name: "o/r" } },
        };
      }
      if (route === COMMIT_ROUTE) {
        return { sha: headSha, parents: [{ sha: baseSha }] };
      }
      throw new Error(`Unexpected request route: ${route}`);
    };

    const result = await adapter().fastForwardOperatorChange({
      owner: "o",
      repo: "r",
      prNumber: 7,
      expectedBaseSha: baseSha,
      expectedHeadSha: headSha,
    });

    expect(result).toMatchObject({ merged: false, status: 409 });
    expect(requestRoutes).not.toContain(UPDATE_REF_ROUTE);
  });

  it("rejects a draft hold before updating the ref", async () => {
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: true,
          base: { ref: "main", sha: baseSha },
          head: { sha: headSha, repo: { full_name: "o/r" } },
        };
      }
      if (route === COMMIT_ROUTE) {
        return { sha: headSha, parents: [{ sha: baseSha }] };
      }
      throw new Error(`Unexpected request route: ${route}`);
    };

    const result = await adapter().fastForwardOperatorChange({
      owner: "o",
      repo: "r",
      prNumber: 7,
      expectedBaseSha: baseSha,
      expectedHeadSha: headSha,
    });

    expect(result).toMatchObject({ merged: false, status: 409 });
    expect(requestRoutes).not.toContain(UPDATE_REF_ROUTE);
  });

  it("fails the concurrent loser when GitHub rejects a non-fast-forward", async () => {
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          base: { ref: "main", sha: baseSha },
          head: { sha: headSha, repo: { full_name: "o/r" } },
        };
      }
      if (route === COMMIT_ROUTE) {
        return { sha: headSha, parents: [{ sha: baseSha }] };
      }
      if (route === UPDATE_REF_ROUTE) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
        });
      }
      throw new Error(`Unhandled request route: ${route}`);
    };

    const result = await adapter().fastForwardOperatorChange({
      owner: "o",
      repo: "r",
      prNumber: 7,
      expectedBaseSha: baseSha,
      expectedHeadSha: headSha,
    });

    expect(result).toMatchObject({
      merged: false,
      enqueued: false,
      status: 422,
    });
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
          base: { ref: "main", sha: "base-sha" },
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
      if (route === COMMIT_ROUTE) {
        return {
          parents: [{ sha: "base-sha" }],
          commit: { message: "test commit" },
        };
      }
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
