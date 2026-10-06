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
import type { CiStatusResult } from "@cogni/ai-tools";
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
const graphqlVars: Record<string, unknown>[] = [];

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
      graphqlVars.push(vars);
      return onGraphql(query, vars);
    }
  },
}));

import { GitHubVcsAdapter } from "@/adapters/server/vcs/github-vcs.adapter";

function adapter(): GitHubVcsAdapter {
  return new GitHubVcsAdapter({ appId: "1", privateKey: "k" });
}

function greenMergeCi(overrides: Partial<CiStatusResult> = {}): CiStatusResult {
  return {
    prNumber: 7,
    prTitle: "feat: protected change",
    author: "agent",
    baseBranch: "main",
    headSha: "verified-head-sha",
    mergeable: true,
    reviewDecision: null,
    labels: [],
    draft: false,
    allGreen: true,
    pending: false,
    checks: [],
    ...overrides,
  };
}

const PR_GET_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const MERGE_ROUTE = "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge";
const CHECK_RUNS_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}/check-runs";
const STATUS_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}/status";
const COMMIT_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}";
const UPDATE_REF_ROUTE = "PATCH /repos/{owner}/{repo}/git/refs/{ref}";
const MAIN_REF_ROUTE = "GET /repos/{owner}/{repo}/git/ref/{ref}";
const COMPARE_ROUTE = "GET /repos/{owner}/{repo}/compare/{basehead}";
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
  graphqlVars.length = 0;
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

    const vcs = adapter();
    vi.spyOn(vcs, "getCiStatus").mockResolvedValue(greenMergeCi());
    const result = await vcs.mergePr({
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

    const vcs = adapter();
    vi.spyOn(vcs, "getCiStatus").mockResolvedValue(greenMergeCi());
    const result = await vcs.mergePr({
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
    expect(graphqlVars.at(-1)).toMatchObject({
      pullRequestId: "PR_node_1",
      mergeMethod: "SQUASH",
      expectedHeadOid: "verified-head-sha",
    });
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

    const vcs = adapter();
    vi.spyOn(vcs, "getCiStatus").mockResolvedValue(greenMergeCi());
    const result = await vcs.mergePr({
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

    const vcs = adapter();
    vi.spyOn(vcs, "getCiStatus").mockResolvedValue(greenMergeCi());
    const result = await vcs.mergePr({
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

    const vcs = adapter();
    vi.spyOn(vcs, "getCiStatus").mockResolvedValue(greenMergeCi());
    const result = await vcs.mergePr({
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

  it.each([
    {
      name: "red required checks",
      ci: { allGreen: false },
      expectedStatus: 422,
    },
    {
      name: "pending required checks",
      ci: { pending: true },
      expectedStatus: 422,
    },
    { name: "draft", ci: { draft: true }, expectedStatus: 422 },
    {
      name: "wrong base",
      ci: { baseBranch: "release" },
      expectedStatus: 422,
    },
    {
      name: "merge conflict",
      ci: { mergeable: false },
      expectedStatus: 422,
    },
    {
      name: "review hold or overflow",
      ci: { reviewDecision: "CHANGES_REQUESTED" },
      expectedStatus: 422,
    },
    {
      name: "stale head",
      ci: { headSha: "new-head-sha" },
      expectedStatus: 409,
    },
  ])("fails closed before every REST or GraphQL write for $name", async ({
    ci,
    expectedStatus,
  }) => {
    const vcs = adapter();
    const getCiStatus = vi
      .spyOn(vcs, "getCiStatus")
      .mockResolvedValue(greenMergeCi(ci));

    const result = await vcs.mergePr({
      owner: "o",
      repo: "r",
      prNumber: 7,
      method: "squash",
      expectedHeadSha: "verified-head-sha",
    });

    expect(result).toMatchObject({
      merged: false,
      enqueued: false,
      status: expectedStatus,
    });
    expect(getCiStatus).toHaveBeenCalledOnce();
    expect(requestRoutes).not.toContain(MERGE_ROUTE);
    expect(graphqlQueries).toHaveLength(0);
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
      if (route === MAIN_REF_ROUTE) return { object: { sha: baseSha } };
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
      outcome: "landed",
      sha: headSha,
    });
  });

  it("rejects stale PR base/head facts before updating the ref", async () => {
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) return { object: { sha: "c".repeat(40) } };
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

    expect(result).toMatchObject({
      outcome: "base_advanced",
      currentBaseSha: "c".repeat(40),
    });
    expect(requestRoutes).not.toContain(UPDATE_REF_ROUTE);
  });

  it("rejects a non-main base before updating the ref", async () => {
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) return { object: { sha: baseSha } };
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

    expect(result).toMatchObject({ outcome: "terminal", status: 409 });
    expect(requestRoutes).not.toContain(UPDATE_REF_ROUTE);
  });

  it("rejects a draft hold before updating the ref", async () => {
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) return { object: { sha: baseSha } };
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

    expect(result).toMatchObject({ outcome: "terminal", status: 409 });
    expect(requestRoutes).not.toContain(UPDATE_REF_ROUTE);
  });

  it("fails the concurrent loser when GitHub rejects a non-fast-forward", async () => {
    let mainReads = 0;
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) {
        mainReads += 1;
        return { object: { sha: mainReads === 1 ? baseSha : "c".repeat(40) } };
      }
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
      outcome: "base_advanced",
      currentBaseSha: "c".repeat(40),
    });
  });

  it("surfaces an ambiguous PATCH timeout for durable recovery", async () => {
    let mainReads = 0;
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) {
        mainReads += 1;
        if (mainReads === 1) return { object: { sha: baseSha } };
        throw Object.assign(new Error("timeout"), { status: 504 });
      }
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
        throw Object.assign(new Error("socket closed after write"), {
          status: 504,
        });
      }
      throw new Error(`Unhandled request route: ${route}`);
    };

    await expect(
      adapter().fastForwardOperatorChange({
        owner: "o",
        repo: "r",
        prNumber: 7,
        expectedBaseSha: baseSha,
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({
      outcome: "retryable_or_ambiguous",
      status: 504,
    });
  });

  it("recognizes an ambiguous accepted PATCH without issuing a second write", async () => {
    let mainReads = 0;
    let patchWrites = 0;
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) {
        mainReads += 1;
        return { object: { sha: mainReads === 1 ? baseSha : headSha } };
      }
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
        patchWrites += 1;
        throw Object.assign(new Error("response dropped after write"), {
          status: 504,
        });
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    await expect(
      adapter().fastForwardOperatorChange({
        owner: "o",
        repo: "r",
        prNumber: 7,
        expectedBaseSha: baseSha,
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({ outcome: "landed", sha: headSha });
    expect(patchWrites).toBe(1);
  });

  it("classifies a transient failure before PATCH as retryable with zero writes", async () => {
    onRequest = (route) => {
      if (route === PR_GET_ROUTE) {
        throw Object.assign(new Error("GitHub unavailable"), { status: 503 });
      }
      if (route === COMMIT_ROUTE) {
        return { sha: headSha, parents: [{ sha: baseSha }] };
      }
      if (route === MAIN_REF_ROUTE) return { object: { sha: baseSha } };
      throw new Error(`Unhandled request route: ${route}`);
    };
    await expect(
      adapter().fastForwardOperatorChange({
        owner: "o",
        repo: "r",
        prNumber: 7,
        expectedBaseSha: baseSha,
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({
      outcome: "retryable_or_ambiguous",
      status: 503,
    });
    expect(requestRoutes).not.toContain(UPDATE_REF_ROUTE);
  });

  it.each([
    ["ahead", "landed"],
    ["diverged", "base_advanced"],
  ])("uses exact ancestry after ambiguous PATCH and later main advance: %s", async (ancestryStatus, expectedOutcome) => {
    let mainReads = 0;
    let patchWrites = 0;
    onRequest = (route, params) => {
      if (route === MAIN_REF_ROUTE) {
        mainReads += 1;
        return {
          object: {
            sha: mainReads === 1 ? baseSha : "d".repeat(40),
          },
        };
      }
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
        patchWrites += 1;
        throw Object.assign(new Error("response dropped after write"), {
          status: 504,
        });
      }
      if (route === COMPARE_ROUTE) {
        expect(params.basehead).toBe(`${headSha}...${"d".repeat(40)}`);
        return { status: ancestryStatus };
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    await expect(
      adapter().fastForwardOperatorChange({
        owner: "o",
        repo: "r",
        prNumber: 7,
        expectedBaseSha: baseSha,
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({ outcome: expectedOutcome });
    expect(patchWrites).toBe(1);
  });
});

describe("GitHubVcsAdapter.recoverOperatorChange", () => {
  const signedBaseSha = "b".repeat(40);
  const losingHeadSha = "a".repeat(40);
  const freshMainSha = "c".repeat(40);
  const intent = {
    operation: "env.membership" as const,
    node: "spawny-boi",
    environment: "candidate-a" as const,
    action: "add" as const,
    leaseGeneration: 0,
    recoveryRootSha: losingHeadSha,
    recoveryDepth: 0,
  };
  const request = {
    owner: "o",
    repo: "r",
    prNumber: 7,
    signedBaseSha,
    losingHeadSha,
    intent,
  };

  function recoveryAdapter(writerResult: unknown): GitHubVcsAdapter {
    const vcs = adapter();
    Object.assign(vcs, {
      verifyOperatorChangeInternal: vi.fn().mockResolvedValue({
        eligible: true,
        reason: "eligible",
        headSha: losingHeadSha,
        baseSha: signedBaseSha,
        operation: intent.operation,
        node: intent.node,
        intent,
      }),
      getCiStatus: vi.fn().mockResolvedValue({
        headSha: losingHeadSha,
        baseSha: freshMainSha,
        pending: false,
        allGreen: true,
        reviewDecision: null,
      }),
      createRecoveryWriter: () => ({
        createOperatorChangeRecoveryPr: vi.fn().mockResolvedValue(writerResult),
      }),
    });
    return vcs;
  }

  it("closes an already-satisfied exact PR only while main remains at the planned SHA", async () => {
    let closeWrites = 0;
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) return { object: { sha: freshMainSha } };
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          merged_at: null,
          base: { ref: "main", sha: freshMainSha },
          head: { sha: losingHeadSha, repo: { full_name: "o/r" } },
        };
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        closeWrites += 1;
        return { state: "closed" };
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    const vcs = recoveryAdapter({ status: "satisfied", mainSha: freshMainSha });
    await expect(vcs.recoverOperatorChange(request)).resolves.toEqual({
      status: "satisfied",
      reason: "intent_already_satisfied",
      mainSha: freshMainSha,
    });
    expect(closeWrites).toBe(1);
  });

  it("retries with zero close when main moves after the satisfaction plan", async () => {
    let mainReads = 0;
    let closeWrites = 0;
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) {
        mainReads += 1;
        return {
          object: {
            sha: mainReads === 1 ? freshMainSha : "d".repeat(40),
          },
        };
      }
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          merged_at: null,
          base: { ref: "main", sha: freshMainSha },
          head: { sha: losingHeadSha, repo: { full_name: "o/r" } },
        };
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        closeWrites += 1;
        return {};
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    const vcs = recoveryAdapter({ status: "satisfied", mainSha: freshMainSha });
    await expect(vcs.recoverOperatorChange(request)).rejects.toThrow(
      "main-moved-after-satisfaction-plan"
    );
    expect(closeWrites).toBe(0);
  });

  it.each([
    "required check regresses",
    "review hold appears",
    "parent catalog moves",
    "PR head is edited",
    "PR becomes draft or closed",
  ])("returns terminal with zero close when %s before satisfaction close", async (race) => {
    let closeWrites = 0;
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) return { object: { sha: freshMainSha } };
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          merged_at: null,
          base: { ref: "main", sha: freshMainSha },
          head: { sha: losingHeadSha, repo: { full_name: "o/r" } },
        };
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        closeWrites += 1;
        return {};
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    const vcs = recoveryAdapter({ status: "satisfied", mainSha: freshMainSha });
    if (
      race === "required check regresses" ||
      race === "review hold appears"
    ) {
      vi.mocked(vcs.getCiStatus)
        .mockResolvedValueOnce({
          headSha: losingHeadSha,
          baseSha: freshMainSha,
          pending: false,
          allGreen: true,
          reviewDecision: null,
        } as never)
        .mockResolvedValueOnce({
          headSha: losingHeadSha,
          baseSha: freshMainSha,
          pending: false,
          allGreen: race !== "required check regresses",
          reviewDecision:
            race === "review hold appears" ? "CHANGES_REQUESTED" : null,
        } as never);
    } else {
      const verifier = (
        vcs as unknown as {
          verifyOperatorChangeInternal: ReturnType<typeof vi.fn>;
        }
      ).verifyOperatorChangeInternal;
      verifier.mockResolvedValueOnce({
        eligible: true,
        reason: "eligible",
        headSha: losingHeadSha,
        baseSha: signedBaseSha,
        operation: intent.operation,
        node: intent.node,
        intent,
      });
      verifier.mockResolvedValueOnce({
        eligible: false,
        reason:
          race === "parent catalog moves"
            ? "operation-replay-failed"
            : "invalid-pr-identity",
        headSha: losingHeadSha,
        baseSha: signedBaseSha,
      });
    }
    await expect(vcs.recoverOperatorChange(request)).resolves.toEqual({
      status: "terminal",
      reason: "losing-pr-no-longer-authorized-before-close",
    });
    expect(closeWrites).toBe(0);
  });

  it("stops before policy or writer work when a human edits the losing head", async () => {
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) return { object: { sha: freshMainSha } };
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          merged_at: null,
          base: { ref: "main", sha: freshMainSha },
          head: { sha: "e".repeat(40), repo: { full_name: "o/r" } },
        };
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    const vcs = recoveryAdapter({ status: "satisfied", mainSha: freshMainSha });
    await expect(vcs.recoverOperatorChange(request)).resolves.toMatchObject({
      status: "terminal",
      reason: "losing-pr-head-changed",
    });
    expect(
      (vcs as unknown as { verifyOperatorChangeInternal: ReturnType<typeof vi.fn> })
        .verifyOperatorChangeInternal
    ).not.toHaveBeenCalled();
  });

  it("keeps disabled policy, conflicts, depth exhaustion, and closed-unsatisfied terminal", async () => {
    onRequest = (route) => {
      if (route === MAIN_REF_ROUTE) return { object: { sha: freshMainSha } };
      if (route === PR_GET_ROUTE) {
        return {
          state: "open",
          draft: false,
          merged_at: null,
          base: { ref: "main", sha: freshMainSha },
          head: { sha: losingHeadSha, repo: { full_name: "o/r" } },
        };
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    const disabled = recoveryAdapter({ status: "conflict", reason: "unused" });
    Object.assign(disabled, {
      verifyOperatorChangeInternal: vi.fn().mockResolvedValue({
        eligible: false,
        reason: "operation-disabled",
        headSha: losingHeadSha,
        baseSha: signedBaseSha,
      }),
    });
    await expect(disabled.recoverOperatorChange(request)).resolves.toMatchObject({
      status: "terminal",
      reason: "losing-head-verification-failed:operation-disabled",
    });
    for (const reason of [
      "node-register-footprint-conflict",
      "recovery-depth-exhausted",
      "closed-pr-intent-not-satisfied",
    ]) {
      const vcs = recoveryAdapter({ status: "conflict", reason });
      await expect(vcs.recoverOperatorChange(request)).resolves.toEqual({
        status: "terminal",
        reason,
      });
    }
  });

  it("derives closed-unsatisfied through the real recovery writer", async () => {
    const node = "blue";
    const repository = "o/blue";
    const deploymentIntent = {
      operation: "deployment.declare" as const,
      node,
      recoveryRootSha: losingHeadSha,
      recoveryDepth: 0,
    };
    const baseSpec = `schema_version: "0.1.4"\nnode_id: "11111111-1111-4111-8111-111111111111"\nscope_id: "22222222-2222-4222-8222-222222222222"\nscope_key: "default"\nintent:\n  name: blue\n  mission: "test"\ngovernance:\n  dao_contract: "0x1111111111111111111111111111111111111111"\n  chain_id: "8453"\n`;
    const encode = (value: string) => Buffer.from(value).toString("base64");
    onRequest = (route, params) => {
      if (route === MAIN_REF_ROUTE) return { object: { sha: freshMainSha } };
      if (route === PR_GET_ROUTE) {
        return {
          state: "closed",
          draft: false,
          merged_at: null,
          base: { ref: "main", sha: freshMainSha },
          head: { sha: losingHeadSha, repo: { full_name: repository } },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        return { tree: { sha: "base-tree" } };
      }
      if (route === CONTENTS_ROUTE) {
        const value =
          params.repo === "control"
            ? "name: blue\nsource_repo: https://github.com/o/blue.git\n"
            : baseSpec;
        return {
          type: "file",
          encoding: "base64",
          content: encode(value),
          sha: "content",
        };
      }
      throw new Error(`Unhandled request route: ${route}`);
    };
    const vcs = new GitHubVcsAdapter({
      appId: "1",
      privateKey: "k",
      operatorChangePolicyOwner: "parent",
      operatorChangePolicyRepo: "control",
    });
    Object.assign(vcs, {
      verifyOperatorChangeInternal: vi.fn().mockResolvedValue({
        eligible: true,
        reason: "eligible",
        headSha: losingHeadSha,
        baseSha: signedBaseSha,
        operation: deploymentIntent.operation,
        node,
        intent: deploymentIntent,
      }),
      getCiStatus: vi.fn().mockResolvedValue({
        headSha: losingHeadSha,
        baseSha: freshMainSha,
        pending: false,
        allGreen: true,
        reviewDecision: null,
      }),
    });

    await expect(
      vcs.recoverOperatorChange({
        owner: "o",
        repo: node,
        prNumber: 7,
        signedBaseSha,
        losingHeadSha,
        intent: deploymentIntent,
      })
    ).resolves.toEqual({
      status: "terminal",
      reason: "closed-pr-intent-not-satisfied",
    });
    expect(requestRoutes.some((route) => /^(PATCH|POST) /.test(route))).toBe(
      false
    );
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
