// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/review/github-review.adapter`
 * Purpose: Unit tests for the operator-owned review GitHub plane.
 * Scope: fetchPrContext repo-spec orchestration. Auth is mocked; no real GitHub I/O.
 * Invariants:
 *   - Root repo-spec routes the owning node.
 *   - The owning node's own .cogni/repo-spec.yaml supplies review gates.
 *   - AI rule model selection lives on the rule file.
 * Side-effects: none
 * Links: task.5052
 * @internal
 */

import { TEST_NODE_ENTRIES, TEST_NODE_IDS } from "@cogni/repo-spec/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

const requests: Array<{ route: string; params: unknown }> = [];
let routeHandlers: Record<string, (params: unknown) => unknown> = {};

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

const rootRepoSpecYaml = stringifyYaml({
  node_id: TEST_NODE_IDS.operator,
  scope_id: "00000000-0000-4000-8000-000000000002",
  governance: { chain_id: "8453" },
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
});

const nodeSpecWithGates = stringifyYaml({
  node_id: TEST_NODE_IDS.operator,
  scope_id: "00000000-0000-4000-8000-000000000002",
  governance: { chain_id: "8453" },
  gates: [{ type: "ai-rule", with: { rule_file: "quality.rule.yaml" } }],
});

const nodeSpecNoGates = stringifyYaml({
  node_id: TEST_NODE_IDS.operator,
  scope_id: "00000000-0000-4000-8000-000000000002",
  governance: { chain_id: "8453" },
});

const ruleYaml = stringifyYaml({
  id: "quality",
  model: "llama-3.3-70b",
  evaluations: [{ quality: "Is it good?" }],
  success_criteria: { require: [{ metric: "quality", gte: 0.8 }] },
});

interface FetchPrFakes {
  changedFiles: string[];
  ruleAvailableAt?: string;
  nodeSpecPath?: string;
  nodeSpecYaml?: string;
  rootSpecYaml?: string;
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
        return fakes.rootSpecYaml ?? rootRepoSpecYaml;
      if (fakes.nodeSpecPath && path === fakes.nodeSpecPath)
        return fakes.nodeSpecYaml ?? nodeSpecWithGates;
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

describe("fetchPrContext", () => {
  it("routes a poly PR and loads gates/rules from poly-owned .cogni", async () => {
    setFetchPrHandlers({
      changedFiles: ["nodes/poly/app/src/foo.ts"],
      nodeSpecPath: "nodes/poly/.cogni/repo-spec.yaml",
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
    expect(result.gatesConfig.gates).toHaveLength(1);
    expect(result.rules["quality.rule.yaml"]?.model).toBe("llama-3.3-70b");

    const fetchedPaths = requests
      .filter((r) => r.route === "GET /repos/{owner}/{repo}/contents/{path}")
      .map((r) => (r.params as { path: string }).path);
    expect(fetchedPaths).toContain("nodes/poly/.cogni/repo-spec.yaml");
    expect(fetchedPaths).toContain("nodes/poly/.cogni/rules/quality.rule.yaml");
  });

  it("routes an operator PR and loads operator-owned gates/rules", async () => {
    setFetchPrHandlers({
      changedFiles: ["packages/repo-spec/src/x.ts"],
      nodeSpecPath: "nodes/operator/.cogni/repo-spec.yaml",
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
    expect(result.gatesConfig.gates).toHaveLength(1);
    expect(result.rules["quality.rule.yaml"]?.model).toBe("llama-3.3-70b");
  });

  it("returns conflict for cross-domain PRs without loading node rules", async () => {
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
    expect(result.gatesConfig.gates).toHaveLength(0);
    const ruleFetches = requests.filter((r) =>
      (r.params as { path?: string }).path?.includes("/rules/")
    );
    expect(ruleFetches).toHaveLength(0);
  });

  it("returns empty gates when the owning node has no gates", async () => {
    setFetchPrHandlers({
      changedFiles: ["packages/repo-spec/src/x.ts"],
      nodeSpecPath: "nodes/operator/.cogni/repo-spec.yaml",
      nodeSpecYaml: nodeSpecNoGates,
    });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.owningNode.kind).toBe("single");
    expect(result.gatesConfig.gates).toHaveLength(0);
    expect(result.rules).toEqual({});
  });

  it("single-node root repos use root .cogni for gates and rules", async () => {
    setFetchPrHandlers({
      changedFiles: ["app/src/foo.ts"],
      rootSpecYaml: nodeSpecWithGates,
      ruleAvailableAt: ".cogni/rules/quality.rule.yaml",
    });

    const result = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "node-at-root",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.owningNode.kind).toBe("single");
    if (result.owningNode.kind === "single") {
      expect(result.owningNode.path).toBe(".");
    }
    expect(result.gatesConfig.gates).toHaveLength(1);
    expect(result.rules["quality.rule.yaml"]?.model).toBe("llama-3.3-70b");
  });
});
