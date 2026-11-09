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

// App-JWT mint for the installation lookup (task.5438); the lookup itself is a stubbed `fetch`.
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "app-jwt" }),
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
      governance: { chain_id: "8453" },
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
    expect(result.modelRef.modelId).toBe("deepseek-v4-flash");
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

describe("story.5102 — pinned review subject + request-bound check", () => {
  it("reads repo-spec + rules at the pinned baseSha and reports headMoved", async () => {
    setFetchPrHandlers({
      changedFiles: ["nodes/poly/app/src/foo.ts"],
      ruleAvailableAt: "nodes/poly/.cogni/rules/quality.rule.yaml",
    });
    const baseSha = "b".repeat(40);

    const moved = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
      baseSha,
      headSha: "c".repeat(40),
    });
    expect(moved.headMoved).toBe(true);
    const contentRefs = requests
      .filter((r) => r.route === "GET /repos/{owner}/{repo}/contents/{path}")
      .map((r) => (r.params as { ref: string }).ref);
    expect(contentRefs.length).toBeGreaterThan(0);
    expect(contentRefs.every((ref) => ref === baseSha)).toBe(true);

    const pinned = await makeAdapter().fetchPrContext({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
      baseSha,
      headSha: "deadbeef",
    });
    expect(pinned.headMoved).toBe(false);
  });

  it("writes the request id as the check run external_id", async () => {
    routeHandlers = {
      "POST /repos/{owner}/{repo}/check-runs": () => ({ id: 7 }),
    };
    const id = await makeAdapter().createCheckRun({
      owner: "org",
      repo: "repo",
      headSha: "deadbeef",
      installationId: 1,
      externalId: "req-1",
    });
    expect(id).toBe(7);
    expect(requests[0]?.params).toMatchObject({
      name: "Cogni Git PR Review",
      head_sha: "deadbeef",
      external_id: "req-1",
    });
  });
});

describe("repo-spec absence is 404 only (story.5102 review fix)", () => {
  function withRepoSpecError(status: number | undefined) {
    setFetchPrHandlers({ changedFiles: ["nodes/poly/app/src/foo.ts"] });
    routeHandlers["GET /repos/{owner}/{repo}/contents/{path}"] = () => {
      throw Object.assign(new Error("repo-spec read failed"), { status });
    };
  }
  const target = {
    owner: "org",
    repo: "repo",
    prNumber: 123,
    installationId: 1,
  };

  it("treats a 404 repo-spec as absent (no gates, miss)", async () => {
    withRepoSpecError(404);
    const result = await makeAdapter().fetchPrContext(target);
    expect(result.gatesConfig.gates).toEqual([]);
    expect(result.owningNode.kind).toBe("miss");
  });

  it.each([
    500,
    401,
    undefined,
  ])("throws on a %s repo-spec read so Temporal retries", async (status) => {
    withRepoSpecError(status);
    await expect(makeAdapter().fetchPrContext(target)).rejects.toThrow(
      "repo-spec read failed"
    );
  });
});

describe("task.5438 — merge-queue verdict I/O", () => {
  const headSha = "a".repeat(40);
  const queueSha = "b".repeat(40);
  const runOf = (
    id: number,
    appId: number,
    conclusion: string | null,
    status = "completed"
  ) => ({
    id,
    name: "Cogni Git PR Review",
    app: { id: appId },
    status,
    conclusion,
    html_url: `https://example.test/runs/${id}`,
  });
  const stubInstallation = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ id: 99 }) }))
    );
  const readTarget = {
    owner: "org",
    repo: "repo",
    prNumber: 12,
    queueSha,
  };

  it("reads the PR head, its review runs, and whether the App already wrote the queue verdict", async () => {
    stubInstallation();
    try {
      routeHandlers = {
        "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
          head: { sha: headSha },
        }),
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": (params) =>
          (params as { ref: string }).ref === headSha
            ? { check_runs: [runOf(5, 1, "success"), runOf(6, 777, "failure")] }
            : { check_runs: [runOf(9, 1, "success")] },
      };
      const inputs = await makeAdapter().readQueueVerdictInputs(readTarget);
      expect(inputs.installationId).toBe(99);
      expect(inputs.headSha).toBe(headSha);
      expect(inputs.headRuns.map((r) => [r.id, r.appId, r.conclusion])).toEqual(
        [
          [5, 1, "success"],
          [6, 777, "failure"],
        ]
      );
      // appId "1" wrote a completed run on the queue commit, so a redelivery is a no-op.
      expect(inputs.queueHasVerdict).toBe(true);
      const listed = requests.filter((r) => r.route.includes("check-runs"));
      expect(listed[0]?.params).toMatchObject({
        check_name: "Cogni Git PR Review",
        filter: "all",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not treat a foreign App's run on the queue commit as already written", async () => {
    stubInstallation();
    try {
      routeHandlers = {
        "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
          head: { sha: headSha },
        }),
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": (params) =>
          (params as { ref: string }).ref === headSha
            ? { check_runs: [] }
            : { check_runs: [runOf(9, 777, "success")] },
      };
      const inputs = await makeAdapter().readQueueVerdictInputs(readTarget);
      expect(inputs.queueHasVerdict).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("writes a completed, same-named check run on the queue commit", async () => {
    routeHandlers = {
      "POST /repos/{owner}/{repo}/check-runs": () => ({ id: 41 }),
    };
    const id = await makeAdapter().writeQueueVerdict({
      installationId: 99,
      owner: "org",
      repo: "repo",
      queueSha,
      verdict: { conclusion: "failure", title: "t", summary: "s" },
    });
    expect(id).toBe(41);
    expect(requests[0]?.params).toMatchObject({
      name: "Cogni Git PR Review",
      head_sha: queueSha,
      status: "completed",
      conclusion: "failure",
      output: { title: "t", summary: "s" },
    });
  });
});
