// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/review/github-review.adapter`
 * Purpose: Unit tests for the operator-owned review GitHub plane — owning-node
 *   routing + per-node rule-path resolution (moved here from the scheduler-worker
 *   under bug.5000). Uses a fake Octokit; no real GitHub I/O.
 * Scope: fetchPrContext repo-spec orchestration. Auth + thin routes tested elsewhere.
 * Invariants:
 *   - PER_NODE_RULE_LOADING: non-operator singles fetch from <path>/.cogni/rules/.
 *   - operator singles use nodes/operator/.cogni/rules/ (no special case).
 *   - cross-domain PRs resolve to owningNode=conflict.
 * Side-effects: none
 * Links: bug.5000, task.0410
 * @internal
 */

import { TEST_NODE_ENTRIES, TEST_NODE_IDS } from "@cogni/repo-spec/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

// Shared request log + handler map mutated per-test before invoking the adapter.
const requests: Array<{ route: string; params: unknown }> = [];
let routeHandlers: Record<string, (params: unknown) => unknown> = {};

// Mock the installation-octokit factory — the adapter's only GitHub seam.
vi.mock("@/adapters/server/review/github-auth", () => ({
  createInstallationOctokit: () => ({
    request: async (route: string, params: unknown) => {
      requests.push({ route, params });
      const handler = routeHandlers[route];
      if (!handler) throw new Error(`Unhandled route in test: ${route}`);
      return { data: handler(params) };
    },
  }),
}));

import { createGithubReviewAdapter } from "@/adapters/server/review/github-review.adapter";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof createGithubReviewAdapter>[0]["logger"];

const minimalRepoSpecYaml = stringifyYaml({
  node_id: TEST_NODE_IDS.operator,
  scope_id: "00000000-0000-4000-8000-000000000002",
  cogni_dao: { chain_id: "8453" },
  payments_in: {
    credits_topup: {
      provider: "cogni-usdc-backend-v1",
      receiving_address: "0x1111111111111111111111111111111111111111",
    },
  },
  nodes: [
    TEST_NODE_ENTRIES.operator,
    TEST_NODE_ENTRIES.poly,
    TEST_NODE_ENTRIES.resy,
  ],
  gates: [{ type: "ai-rule", with: { rule_file: "quality.rule.yaml" } }],
});

const ruleYaml = stringifyYaml({
  id: "quality",
  evaluations: [{ quality: "Is it good?" }],
  success_criteria: { require: [{ metric: "quality", gte: 0.8 }] },
});

interface FetchPrFakes {
  changedFiles: string[];
  ruleAvailableAt?: string;
  /** Override the served repo-spec YAML (defaults to minimalRepoSpecYaml). */
  repoSpecYaml?: string;
}

function setFetchPrHandlers(fakes: FetchPrFakes): void {
  routeHandlers = {
    "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
      number: 123,
      title: "test pr",
      body: "",
      head: { sha: "deadbeef" },
      base: { ref: "main" },
      changed_files: fakes.changedFiles.length,
      additions: 1,
      deletions: 0,
    }),
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": () =>
      fakes.changedFiles.map((f) => ({ filename: f, patch: "+x" })),
    "GET /repos/{owner}/{repo}/contents/{path}": (params: unknown) => {
      const { path } = params as { path: string };
      if (path === ".cogni/repo-spec.yaml")
        return fakes.repoSpecYaml ?? minimalRepoSpecYaml;
      if (fakes.ruleAvailableAt && path === fakes.ruleAvailableAt)
        return ruleYaml;
      const err = new Error(`Not Found: ${path}`) as Error & {
        status?: number;
      };
      err.status = 404;
      throw err;
    },
  };
}

function makeAdapter() {
  return createGithubReviewAdapter({
    appId: "1",
    privateKeyBase64: "key",
    logger: mockLogger,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  routeHandlers = {};
});

describe("fetchPrContext — owning-node routing", () => {
  it("returns owningNode=single + fetches rules from per-node path for poly PR", async () => {
    setFetchPrHandlers({
      changedFiles: ["nodes/poly/app/src/foo.ts"],
      ruleAvailableAt: "nodes/poly/.cogni/rules/quality.rule.yaml",
    });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.owningNode.kind).toBe("single");
    if (result.owningNode.kind === "single") {
      expect(result.owningNode.path).toBe("nodes/poly");
    }
    expect(result.changedFiles).toEqual(["nodes/poly/app/src/foo.ts"]);

    const ruleFetches = requests.filter(
      (r) =>
        r.route === "GET /repos/{owner}/{repo}/contents/{path}" &&
        (r.params as { path: string }).path.endsWith("quality.rule.yaml")
    );
    expect(ruleFetches.length).toBe(1);
    expect((ruleFetches[0]?.params as { path: string }).path).toBe(
      "nodes/poly/.cogni/rules/quality.rule.yaml"
    );
  });

  it("operator-only PR fetches rules from nodes/operator/.cogni/rules/ (no special case)", async () => {
    setFetchPrHandlers({
      changedFiles: ["packages/repo-spec/src/x.ts"],
      ruleAvailableAt: "nodes/operator/.cogni/rules/quality.rule.yaml",
    });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.owningNode.kind).toBe("single");
    if (result.owningNode.kind === "single") {
      expect(result.owningNode.path).toBe("nodes/operator");
    }

    const ruleFetches = requests.filter(
      (r) =>
        r.route === "GET /repos/{owner}/{repo}/contents/{path}" &&
        (r.params as { path: string }).path.endsWith("quality.rule.yaml")
    );
    expect(ruleFetches.length).toBe(1);
    expect((ruleFetches[0]?.params as { path: string }).path).toBe(
      "nodes/operator/.cogni/rules/quality.rule.yaml"
    );
  });

  it("cross-domain PR returns owningNode=conflict", async () => {
    setFetchPrHandlers({
      changedFiles: ["nodes/poly/x.ts", "nodes/resy/y.ts"],
    });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.owningNode.kind).toBe("conflict");
    if (result.owningNode.kind === "conflict") {
      expect(result.owningNode.nodes.map((n) => n.nodeId)).toEqual(
        expect.arrayContaining([TEST_NODE_IDS.poly, TEST_NODE_IDS.resy])
      );
    }
  });

  it("ride-along (poly + pnpm-lock.yaml) routes to single poly", async () => {
    setFetchPrHandlers({
      changedFiles: ["nodes/poly/x.ts", "pnpm-lock.yaml"],
      ruleAvailableAt: "nodes/poly/.cogni/rules/quality.rule.yaml",
    });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.owningNode.kind).toBe("single");
    if (result.owningNode.kind === "single") {
      expect(result.owningNode.nodeId).toBe(TEST_NODE_IDS.poly);
      expect(result.owningNode.rideAlongApplied).toBe(true);
    }
  });
});

describe("fetchPrContext — review on/off + model (repo-spec driven)", () => {
  /** Builds a repo-spec yaml carrying an optional review block. */
  function specWithReview(review?: Record<string, unknown>): string {
    return stringifyYaml({
      node_id: TEST_NODE_IDS.operator,
      scope_id: "00000000-0000-4000-8000-000000000002",
      cogni_dao: { chain_id: "8453" },
      payments_in: {
        credits_topup: {
          provider: "cogni-usdc-backend-v1",
          receiving_address: "0x1111111111111111111111111111111111111111",
        },
      },
      nodes: [TEST_NODE_ENTRIES.operator],
      ...(review ? { review } : {}),
      gates: [{ type: "ai-rule", with: { rule_file: "quality.rule.yaml" } }],
    });
  }

  it("defaults to reviewEnabled=true + operator default model when no review block", async () => {
    setFetchPrHandlers({ changedFiles: ["packages/repo-spec/src/x.ts"] });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.reviewEnabled).toBe(true);
    expect(result.modelRef.modelId).toBe("gpt-4o-mini");
  });

  it("propagates review.enabled=false (node opts out)", async () => {
    setFetchPrHandlers({
      changedFiles: ["packages/repo-spec/src/x.ts"],
      repoSpecYaml: specWithReview({ enabled: false }),
    });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.reviewEnabled).toBe(false);
  });

  it("uses the node-selected review.model", async () => {
    setFetchPrHandlers({
      changedFiles: ["packages/repo-spec/src/x.ts"],
      ruleAvailableAt: "nodes/operator/.cogni/rules/quality.rule.yaml",
      repoSpecYaml: specWithReview({
        enabled: true,
        model: "claude-haiku-4-5",
      }),
    });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.reviewEnabled).toBe(true);
    expect(result.modelRef).toEqual({
      providerKey: "platform",
      modelId: "claude-haiku-4-5",
    });
  });
});
