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
