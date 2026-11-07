// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/review-activities.test`
 * Purpose: Unit tests for the review activities' delegation to the operator
 *   review plane (bug.5000). All GitHub I/O is HTTP-delegated; these tests use a
 *   fake ReviewHttpClient and assert the worker orchestrates + re-logs correctly.
 * Scope: Activity behavior with a fake ReviewHttpClient. No GitHub SDK.
 * Invariants:
 *   - WORKER_HOLDS_NO_GITHUB_CRED: activities never touch Octokit.
 *   - review.routed log emitted with owningNode shape.
 *   - postRoutingDiagnosticActivity finalizes neutral check + diagnostic comment.
 * Side-effects: none
 * Links: bug.5000, task.0410
 * @internal
 */

import { TEST_NODE_IDS } from "@cogni/repo-spec/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewActivities } from "../src/activities/review.js";
import type { ReviewHttpClient } from "../src/ports/index.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof createReviewActivities>[0]["logger"];

function makeContext(
  owningNode: Awaited<
    ReturnType<ReviewHttpClient["fetchPrContext"]>
  >["owningNode"],
  changedFiles: string[]
): Awaited<ReturnType<ReviewHttpClient["fetchPrContext"]>> {
  return {
    evidence: {
      prNumber: 123,
      prTitle: "test pr",
      prBody: "",
      headSha: "deadbeef",
      baseBranch: "main",
      changedFiles: changedFiles.length,
      additions: 1,
      deletions: 0,
      patches: [],
      totalDiffBytes: 0,
    },
    reviewEnabled: true,
    gatesConfig: { gates: [], failOnError: false },
    rules: {},
    graphMessages: [],
    responseFormat: { prompt: "", schemaId: "" },
    modelRef: { providerKey: "platform", modelId: "gpt-4o-mini" },
    changedFiles,
    owningNode,
  };
}

let client: {
  createCheckRun: ReturnType<typeof vi.fn>;
  updateCheckRun: ReturnType<typeof vi.fn>;
  postPrComment: ReturnType<typeof vi.fn>;
  fetchPrContext: ReturnType<typeof vi.fn>;
};

function makeActivities() {
  return createReviewActivities({
    reviewClient: client as unknown as ReviewHttpClient,
    logger: mockLogger,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  client = {
    createCheckRun: vi.fn(async () => 42),
    updateCheckRun: vi.fn(async () => undefined),
    postPrComment: vi.fn(async () => ({ posted: true })),
    fetchPrContext: vi.fn(async () => makeContext({ kind: "miss" }, [])),
  };
});

describe("createCheckRunActivity", () => {
  it("delegates to the operator review plane and returns the check-run id", async () => {
    const acts = makeActivities();
    const id = await acts.createCheckRunActivity({
      owner: "org",
      repo: "repo",
      headSha: "deadbeef",
      installationId: 1,
    });
    expect(id).toBe(42);
    expect(client.createCheckRun).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      headSha: "deadbeef",
      installationId: 1,
    });
  });
});

describe("fetchPrContextActivity", () => {
  it("delegates to the operator and re-emits review.routed for a single poly PR", async () => {
    client.fetchPrContext.mockResolvedValueOnce(
      makeContext(
        { kind: "single", nodeId: TEST_NODE_IDS.poly, path: "nodes/poly" },
        ["nodes/poly/app/src/foo.ts"]
      )
    );
    const acts = makeActivities();

    const result = await acts.fetchPrContextActivity({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(result.owningNode.kind).toBe("single");
    expect(client.fetchPrContext).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        owningNodeKind: "single",
        owningNodePath: "nodes/poly",
        changedFileCount: 1,
        prNumber: 123,
      }),
      "review.routed"
    );
  });

  it("re-emits conflict node ids for a cross-domain PR", async () => {
    client.fetchPrContext.mockResolvedValueOnce(
      makeContext(
        {
          kind: "conflict",
          nodes: [
            { nodeId: TEST_NODE_IDS.poly, path: "nodes/poly" },
            { nodeId: TEST_NODE_IDS.resy, path: "nodes/resy" },
          ],
          operatorPaths: [],
        },
        ["nodes/poly/x.ts", "nodes/resy/y.ts"]
      )
    );
    const acts = makeActivities();

    await acts.fetchPrContextActivity({
      owner: "org",
      repo: "repo",
      prNumber: 123,
      installationId: 1,
    });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        owningNodeKind: "conflict",
        conflictNodeIds: expect.arrayContaining([
          TEST_NODE_IDS.poly,
          TEST_NODE_IDS.resy,
        ]),
      }),
      "review.routed"
    );
  });
});

describe("postRoutingDiagnosticActivity", () => {
  it("finalizes a neutral check + diagnostic comment for conflict", async () => {
    const acts = makeActivities();

    await acts.postRoutingDiagnosticActivity({
      owner: "org",
      repo: "repo",
      prNumber: 7,
      headSha: "deadbeef",
      installationId: 1,
      checkRunId: 99,
      owningNode: {
        kind: "conflict",
        nodes: [
          { nodeId: "poly", path: "nodes/poly" },
          { nodeId: "resy", path: "nodes/resy" },
        ],
        operatorPaths: [],
      },
      changedFiles: ["nodes/poly/a.ts", "nodes/resy/b.ts"],
    });

    expect(client.updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 99, conclusion: "neutral" })
    );
    const commentArg = client.postPrComment.mock.calls[0]?.[0] as {
      body: string;
    };
    expect(commentArg.body).toContain("Cross-Domain PR refused");
  });

  it("posts neutral 'no recognizable scope' for miss", async () => {
    const acts = makeActivities();

    await acts.postRoutingDiagnosticActivity({
      owner: "org",
      repo: "repo",
      prNumber: 8,
      headSha: "deadbeef",
      installationId: 1,
      checkRunId: 100,
      owningNode: { kind: "miss" },
      changedFiles: [],
    });

    const commentArg = client.postPrComment.mock.calls[0]?.[0] as {
      body: string;
    };
    expect(commentArg.body).toContain("No recognizable scope");
  });
});

describe("postReviewResultActivity", () => {
  it("finalizes the check run + posts the comment for a no-gates pass", async () => {
    const acts = makeActivities();

    await acts.postReviewResultActivity({
      owner: "org",
      repo: "repo",
      prNumber: 5,
      headSha: "deadbeef",
      installationId: 1,
      checkRunId: 11,
      noGatesConfigured: true,
    });

    expect(client.updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 11, conclusion: "success" })
    );
    expect(client.postPrComment).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 5, expectedHeadSha: "deadbeef" })
    );
  });
});

// ---------------------------------------------------------------------------
// story.5102 — COULD_NOT_EVALUATE_IS_NOT_NEUTRAL + CHECK_IS_REQUEST_BOUND
// ---------------------------------------------------------------------------

const HUB_RULE = {
  id: "hub-rule-compliance",
  schema_version: "0.3",
  blocking: true,
  evaluations: [
    { "complies-with-governing-hub-rules": "Complies with hub rules." },
  ],
  success_criteria: {
    neutral_on_missing_metrics: false,
    require: [{ metric: "complies-with-governing-hub-rules", gte: 0.7 }],
  },
} as unknown as import("@cogni/repo-spec").Rule;

function reviewInput(
  graphResult: { ok: boolean; runId: string; structuredOutput?: unknown },
  failOnError = true
) {
  return {
    owner: "org",
    repo: "repo",
    prNumber: 9,
    headSha: "a".repeat(40),
    installationId: 1,
    checkRunId: 77,
    requestId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    model: "gemini-3.7-flash",
    operatorBuildSha: "c".repeat(40),
    graphResult,
    gatesConfig: {
      gates: [
        { type: "ai-rule", with: { rule_file: "hub-rule-compliance.yaml" } },
      ],
      failOnError,
    },
    rules: { "hub-rule-compliance.yaml": HUB_RULE },
  };
}

function machineBlock(summary: string): Record<string, unknown> {
  const marker = "<!-- cogni-review-result v1 -->";
  const after = summary.slice(summary.indexOf(marker) + marker.length);
  const json = after.match(/```json\n([\s\S]*?)\n```/)?.[1];
  return JSON.parse(json ?? "null");
}

describe("postReviewResultActivity — honest failure (story.5102)", () => {
  it.each([
    ["graph_failed", { ok: false, runId: "r1" }],
    ["no_structured_output", { ok: true, runId: "r2" }],
    [
      "uncited",
      {
        ok: true,
        runId: "r3",
        structuredOutput: {
          metrics: [
            {
              metric: "complies-with-governing-hub-rules",
              value: 0.2,
              observations: ["breaks a rule"],
              citations: [],
            },
          ],
          summary: "s",
          uncited: true,
          evidence: { files: [], entries: [] },
        },
      },
    ],
  ])("maps %s to failure + COULD NOT EVALUATE under fail_on_error", async (reason, graphResult) => {
    const acts = makeActivities();
    await acts.postReviewResultActivity(reviewInput(graphResult));
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      conclusion: string;
      title: string;
      summary: string;
    };
    expect(call.conclusion).toBe("failure");
    expect(call.title).toBe("PR Review: COULD NOT EVALUATE");
    expect(machineBlock(call.summary)).toMatchObject({
      couldNotEvaluate: reason,
      conclusion: "failure",
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review.could_not_evaluate", reason }),
      "review.could_not_evaluate"
    );
  });

  it("maps a missing rule file to failure under fail_on_error", async () => {
    const acts = makeActivities();
    await acts.postReviewResultActivity({
      ...reviewInput({
        ok: true,
        runId: "r4",
        structuredOutput: { metrics: [], summary: "" },
      }),
      rules: {},
    });
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      conclusion: string;
      summary: string;
    };
    expect(call.conclusion).toBe("failure");
    expect(machineBlock(call.summary).couldNotEvaluate).toBe("missing_rule");
  });

  it("keeps a non-evaluation neutral when fail_on_error is false", async () => {
    const acts = makeActivities();
    await acts.postReviewResultActivity(
      reviewInput({ ok: false, runId: "r5" }, false)
    );
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      conclusion: string;
      title: string;
    };
    expect(call.conclusion).toBe("neutral");
    expect(call.title).toBe("PR Review: NEUTRAL");
  });

  it("maps a workflow-reported head_moved to failure", async () => {
    const acts = makeActivities();
    await acts.postReviewResultActivity({
      ...reviewInput({ ok: true, runId: "r6" }),
      graphResult: undefined,
      couldNotEvaluate: "head_moved",
    });
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      conclusion: string;
      summary: string;
    };
    expect(call.conclusion).toBe("failure");
    expect(machineBlock(call.summary).couldNotEvaluate).toBe("head_moved");
  });

  it("an evaluated cited verdict ends the summary with the request-bound block", async () => {
    const acts = makeActivities();
    await acts.postReviewResultActivity(
      reviewInput({
        ok: true,
        runId: "r7",
        structuredOutput: {
          metrics: [
            {
              metric: "complies-with-governing-hub-rules",
              value: 0.1,
              observations: ["writes secrets to logs"],
              citations: ["no-secrets-in-logs"],
            },
          ],
          summary: "breaks no-secrets-in-logs",
          uncited: false,
          buildSha: "b".repeat(40),
          evidence: {
            files: ["nodes/operator/app/src/x.ts"],
            entries: ["no-secrets-in-logs"],
          },
        },
      })
    );
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      conclusion: string;
      title: string;
      summary: string;
    };
    expect(call.conclusion).toBe("failure");
    expect(call.title).toBe("PR Review: FAIL");
    expect(machineBlock(call.summary)).toEqual({
      requestId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      buildSha: "b".repeat(40),
      model: "gemini-3.7-flash",
      conclusion: "failure",
      couldNotEvaluate: null,
      citations: ["no-secrets-in-logs"],
      evidence: {
        files: ["nodes/operator/app/src/x.ts"],
        entries: ["no-secrets-in-logs"],
      },
    });
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "review.could_not_evaluate" }),
      expect.anything()
    );
  });

  it("passes the request id through as the check run external_id", async () => {
    const acts = makeActivities();
    await acts.createCheckRunActivity({
      owner: "org",
      repo: "repo",
      headSha: "deadbeef",
      installationId: 1,
      externalId: "req-1",
    });
    expect(client.createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "req-1" })
    );
  });
});

describe("postReviewResultActivity — review fixes (story.5102)", () => {
  it("a configured metric absent from the verdict is missing_metric, not a threshold failure", async () => {
    const acts = makeActivities();
    await acts.postReviewResultActivity(
      reviewInput({
        ok: true,
        runId: "m1",
        structuredOutput: {
          metrics: [{ metric: "something-else", value: 1, observations: [] }],
          summary: "s",
          uncited: false,
          evidence: { files: ["a.ts"], entries: ["r"] },
        },
      })
    );
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      conclusion: string;
      title: string;
      summary: string;
    };
    expect(call.title).toBe("PR Review: COULD NOT EVALUATE");
    expect(machineBlock(call.summary).couldNotEvaluate).toBe("missing_metric");
    expect(call.summary).not.toContain("failed threshold checks");
  });

  it("a verdict with no code read is no_code_read, even when it would pass", async () => {
    const acts = makeActivities();
    await acts.postReviewResultActivity(
      reviewInput({
        ok: true,
        runId: "m2",
        structuredOutput: {
          metrics: [
            {
              metric: "complies-with-governing-hub-rules",
              value: 1,
              observations: [],
            },
          ],
          summary: "s",
          uncited: false,
          noCodeRead: true,
          evidence: { files: [], entries: ["r"] },
        },
      })
    );
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      conclusion: string;
      summary: string;
    };
    expect(call.conclusion).toBe("failure");
    expect(machineBlock(call.summary).couldNotEvaluate).toBe("no_code_read");
  });

  it("keeps the summary under GitHub's 65,535 chars with the block intact and capped", async () => {
    const acts = makeActivities();
    const many = Array.from({ length: 400 }, (_, i) => `file-${i}.ts`);
    await acts.postReviewResultActivity(
      reviewInput({
        ok: true,
        runId: "m3",
        structuredOutput: {
          metrics: [
            {
              metric: "complies-with-governing-hub-rules",
              value: 0.1,
              observations: Array.from({ length: 2000 }, () => "x".repeat(80)),
              citations: ["r"],
            },
          ],
          summary: "s",
          uncited: false,
          evidence: { files: many, entries: ["r"] },
        },
      })
    );
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      summary: string;
    };
    expect(call.summary.length).toBeLessThanOrEqual(65_535);
    const block = machineBlock(call.summary) as {
      evidence: { files: string[] };
      citations: string[];
    };
    expect(block.evidence.files).toHaveLength(50);
    expect(block.citations).toEqual(["r"]);
  });
});

describe("postRoutingDiagnosticActivity — dev-triggered honours fail_on_error (story.5102)", () => {
  const base = {
    owner: "org",
    repo: "repo",
    prNumber: 9,
    headSha: "a".repeat(40),
    installationId: 1,
    checkRunId: 88,
    changedFiles: [] as string[],
  };

  it.each([
    [
      "routing_conflict",
      {
        kind: "conflict" as const,
        nodes: [
          { nodeId: "poly", path: "nodes/poly" },
          { nodeId: "resy", path: "nodes/resy" },
        ],
        operatorPaths: [],
      },
    ],
    ["routing_miss", { kind: "miss" as const }],
  ])("%s → failure + COULD NOT EVALUATE + machine block", async (reason, owningNode) => {
    const acts = makeActivities();
    await acts.postRoutingDiagnosticActivity({
      ...base,
      owningNode,
      requestId: "req-9",
      model: "gemini-3.7-flash",
      operatorBuildSha: "c".repeat(40),
      failOnError: true,
    });
    const call = client.updateCheckRun.mock.calls[0]?.[0] as {
      conclusion: string;
      title: string;
      summary: string;
    };
    expect(call.conclusion).toBe("failure");
    expect(call.title).toBe("PR Review: COULD NOT EVALUATE");
    expect(machineBlock(call.summary)).toEqual({
      requestId: "req-9",
      buildSha: "c".repeat(40),
      model: "gemini-3.7-flash",
      conclusion: "failure",
      couldNotEvaluate: reason,
      citations: [],
      evidence: { files: [], entries: [] },
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review.could_not_evaluate", reason }),
      "review.could_not_evaluate"
    );
  });

  it("stays neutral with fail_on_error false, and legacy (no requestId) is unchanged", async () => {
    const acts = makeActivities();
    await acts.postRoutingDiagnosticActivity({
      ...base,
      owningNode: { kind: "miss" },
      requestId: "req-10",
      failOnError: false,
    });
    await acts.postRoutingDiagnosticActivity({
      ...base,
      owningNode: { kind: "miss" },
    });
    const [dev, legacy] = client.updateCheckRun.mock.calls.map(
      (c) => c[0] as { conclusion: string; title: string; summary: string }
    );
    expect(dev?.conclusion).toBe("neutral");
    expect(machineBlock(dev?.summary ?? "").couldNotEvaluate).toBe(
      "routing_miss"
    );
    expect(legacy).toMatchObject({
      conclusion: "neutral",
      title: "PR Review: No recognizable scope",
    });
    expect(legacy?.summary).not.toContain("cogni-review-result");
  });
});
