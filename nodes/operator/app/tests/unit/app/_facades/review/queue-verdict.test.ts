// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/review/queue-verdict`
 * Purpose: Unit tests for the merge-queue verdict facade: it acts only on a queue push of the parent
 *   repo, writes exactly one same-named verdict per queue SHA, never writes twice, and fails loudly.
 * Scope: Mocked review GitHub plane; no real GitHub I/O.
 * Invariants: PARENT_REPO_ONLY, OWN_APP_ONLY, NEVER_SKIP_SILENTLY, IDEMPOTENT_ON_QUEUE_SHA, ONE_EVENT_PER_COPY.
 * Side-effects: none
 * Links: src/app/_facades/review/queue-verdict.server.ts, task.5438
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const readQueueVerdictInputs = vi.fn();
const writeQueueVerdict = vi.fn();
const createPlane = vi.fn();

vi.mock("@/bootstrap/review/resolve-review-route", () => ({
  createReviewGithubPlane: (...a: unknown[]) => createPlane(...a),
}));

import { dispatchQueueReviewVerdict } from "@/app/_facades/review/queue-verdict.server";

const APP_ID = 1234;
const HEAD = "a".repeat(40);
const QUEUE = "b".repeat(40);

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof dispatchQueueReviewVerdict>[2];

const env = {
  NODE_SUBMODULE_PARENT_OWNER: "cogni-dao",
  NODE_SUBMODULE_PARENT_REPO: "cogni",
  GH_REVIEW_APP_ID: String(APP_ID),
} as unknown as Parameters<typeof dispatchQueueReviewVerdict>[1];

function queuePush(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ref: `refs/heads/gh-readonly-queue/main/pr-3107-${"c".repeat(40)}`,
    after: QUEUE,
    repository: { name: "cogni", owner: { login: "cogni-dao" } },
    ...over,
  };
}

function headRun(over: Record<string, unknown> = {}) {
  return {
    id: 5,
    name: "Cogni Git PR Review",
    appId: APP_ID,
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://example.test/runs/5",
    ...over,
  };
}

function inputs(over: Record<string, unknown> = {}) {
  return {
    installationId: 99,
    headSha: HEAD,
    headRuns: [headRun()],
    queueHasVerdict: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createPlane.mockReturnValue({ readQueueVerdictInputs, writeQueueVerdict });
  writeQueueVerdict.mockResolvedValue(41);
});

describe("dispatchQueueReviewVerdict", () => {
  it("ignores a default-branch push and a queue push of another repo", async () => {
    await dispatchQueueReviewVerdict(
      queuePush({ ref: "refs/heads/main" }),
      env,
      log
    );
    await dispatchQueueReviewVerdict(
      queuePush({
        repository: { name: "node-template", owner: { login: "cogni-dao" } },
      }),
      env,
      log
    );
    expect(createPlane).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("does nothing when the parent repo is not configured", async () => {
    await dispatchQueueReviewVerdict(
      queuePush(),
      { ...env, NODE_SUBMODULE_PARENT_REPO: undefined } as typeof env,
      log
    );
    expect(createPlane).not.toHaveBeenCalled();
  });

  it("copies a passing head review as success on the queue commit, with one event", async () => {
    readQueueVerdictInputs.mockResolvedValue(inputs());
    await dispatchQueueReviewVerdict(queuePush(), env, log);
    expect(readQueueVerdictInputs).toHaveBeenCalledWith({
      owner: "cogni-dao",
      repo: "cogni",
      prNumber: 3107,
      queueSha: QUEUE,
    });
    expect(writeQueueVerdict).toHaveBeenCalledTimes(1);
    expect(writeQueueVerdict.mock.calls[0]?.[0]).toMatchObject({
      installationId: 99,
      queueSha: QUEUE,
      verdict: { conclusion: "success" },
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.info).mock.calls[0]?.[0]).toMatchObject({
      event: "feature.review_queue_verdict.complete",
      outcome: "copied_success",
      prNumber: 3107,
      checkRunId: 41,
      sourceCheckRunId: 5,
    });
  });

  it("writes failure for a failed head review", async () => {
    readQueueVerdictInputs.mockResolvedValue(
      inputs({ headRuns: [headRun({ conclusion: "failure" })] })
    );
    await dispatchQueueReviewVerdict(queuePush(), env, log);
    expect(writeQueueVerdict.mock.calls[0]?.[0].verdict.conclusion).toBe(
      "failure"
    );
    expect(vi.mocked(log.info).mock.calls[0]?.[0]).toMatchObject({
      outcome: "copied_failure",
    });
  });

  it("writes NOT REVIEWED failure when the head has no review, or only a foreign App's", async () => {
    for (const headRuns of [[], [headRun({ appId: 777 })]]) {
      writeQueueVerdict.mockClear();
      readQueueVerdictInputs.mockResolvedValue(inputs({ headRuns }));
      await dispatchQueueReviewVerdict(queuePush(), env, log);
      expect(writeQueueVerdict).toHaveBeenCalledTimes(1);
      expect(writeQueueVerdict.mock.calls[0]?.[0].verdict).toMatchObject({
        conclusion: "failure",
        title: "PR Review: NOT REVIEWED AT HEAD",
      });
    }
  });

  it("does not write twice for a redelivered push", async () => {
    readQueueVerdictInputs.mockResolvedValue(inputs({ queueHasVerdict: true }));
    await dispatchQueueReviewVerdict(queuePush(), env, log);
    expect(writeQueueVerdict).not.toHaveBeenCalled();
    expect(vi.mocked(log.info).mock.calls[0]?.[0]).toMatchObject({
      outcome: "skipped_exists",
    });
  });

  it("logs and rethrows when the verdict cannot be written", async () => {
    readQueueVerdictInputs.mockResolvedValue(inputs());
    writeQueueVerdict.mockRejectedValue(new Error("github 502"));
    await expect(
      dispatchQueueReviewVerdict(queuePush(), env, log)
    ).rejects.toThrow("github 502");
    expect(vi.mocked(log.error).mock.calls[0]?.[0]).toMatchObject({
      event: "feature.review_queue_verdict.complete",
      outcome: "error",
    });
  });

  it("fails loudly when the review App is not configured", async () => {
    createPlane.mockReturnValue(null);
    await expect(
      dispatchQueueReviewVerdict(queuePush(), env, log)
    ).rejects.toThrow("review App not configured");
  });
});
