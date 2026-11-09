// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/review/queue-verdict.test`
 * Purpose: Prove the pure merge-queue verdict decisions (task.5438): a passing App review on the head
 *   is copied as success; a failing one as failure; no head check, an unfinished one, a neutral one,
 *   and a foreign App's check are all `failure`/ignored; non-queue refs and other repos are ignored;
 *   the PR number parses out of the queue ref.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import {
  decideQueueVerdict,
  extractQueuePush,
  type HeadCheckRun,
  NOT_REVIEWED_TITLE,
  parseQueueRef,
  QUEUE_VERDICT_CHECK_NAME,
  selectHeadVerdictRun,
} from "./queue-verdict";

const APP = 1234;
const HEAD = "a".repeat(40);
const QUEUE = "b".repeat(40);
const PARENT = { owner: "cogni-dao", repo: "cogni" };

function run(over: Partial<HeadCheckRun> & { id: number }): HeadCheckRun {
  return {
    name: QUEUE_VERDICT_CHECK_NAME,
    appId: APP,
    status: "completed",
    conclusion: "success",
    htmlUrl: `https://github.com/cogni-dao/cogni/runs/${over.id}`,
    ...over,
  };
}

function push(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: `refs/heads/gh-readonly-queue/main/pr-3101-${"c".repeat(40)}`,
    after: QUEUE,
    repository: { name: "cogni", owner: { login: "cogni-dao" } },
    ...over,
  };
}

describe("parseQueueRef", () => {
  it("parses the PR number and base branch", () => {
    expect(
      parseQueueRef(
        `refs/heads/gh-readonly-queue/main/pr-3101-${"c".repeat(40)}`
      )
    ).toEqual({ baseBranch: "main", prNumber: 3101 });
  });

  it("handles a base branch with slashes", () => {
    expect(
      parseQueueRef(
        `refs/heads/gh-readonly-queue/release/1.x/pr-7-${"c".repeat(40)}`
      )
    ).toEqual({ baseBranch: "release/1.x", prNumber: 7 });
  });

  it.each([
    "refs/heads/main",
    "refs/heads/feat/pr-12-abc",
    "refs/heads/gh-readonly-queue/main/pr-x-" + "c".repeat(40),
    "refs/heads/gh-readonly-queue/main/pr-0-" + "c".repeat(40),
    "refs/heads/gh-readonly-queue/main/pr-12-short",
    "refs/tags/gh-readonly-queue/main/pr-12-" + "c".repeat(40),
    undefined,
    42,
  ])("ignores %s", (ref) => {
    expect(parseQueueRef(ref)).toBeNull();
  });
});

describe("extractQueuePush", () => {
  it("narrows a queue push of the parent repo", () => {
    expect(extractQueuePush(push(), PARENT)).toEqual({
      owner: "cogni-dao",
      repo: "cogni",
      prNumber: 3101,
      queueSha: QUEUE,
    });
  });

  it("matches the parent repo case-insensitively", () => {
    expect(
      extractQueuePush(push(), { owner: "Cogni-DAO", repo: "Cogni" })
    ).not.toBeNull();
  });

  it("ignores a non-queue ref (a default-branch push)", () => {
    expect(
      extractQueuePush(push({ ref: "refs/heads/main" }), PARENT)
    ).toBeNull();
  });

  it("ignores a queue push of another repository (node repos do not require the review)", () => {
    expect(
      extractQueuePush(
        push({
          repository: { name: "node-template", owner: { login: "cogni-dao" } },
        }),
        PARENT
      )
    ).toBeNull();
  });

  it("ignores a deleted queue branch and malformed after SHAs", () => {
    expect(
      extractQueuePush(push({ after: "0".repeat(40) }), PARENT)
    ).toBeNull();
    expect(extractQueuePush(push({ deleted: true }), PARENT)).toBeNull();
    expect(extractQueuePush(push({ after: "nope" }), PARENT)).toBeNull();
    expect(extractQueuePush({ ref: push().ref }, PARENT)).toBeNull();
  });
});

describe("selectHeadVerdictRun", () => {
  it("ignores another App's check of the same name", () => {
    expect(
      selectHeadVerdictRun(
        [run({ id: 9, appId: 777, conclusion: "success" })],
        APP
      )
    ).toBeNull();
  });

  it("ignores differently named checks and unfinished runs", () => {
    expect(
      selectHeadVerdictRun(
        [
          run({ id: 1, name: "unit" }),
          run({ id: 2, status: "in_progress", conclusion: null }),
        ],
        APP
      )
    ).toBeNull();
  });

  it("takes the latest completed run of the App", () => {
    const latest = selectHeadVerdictRun(
      [
        run({ id: 4, conclusion: "failure" }),
        run({ id: 8, conclusion: "success" }),
        run({ id: 9, status: "in_progress", conclusion: null }),
      ],
      APP
    );
    expect(latest?.id).toBe(8);
  });
});

describe("decideQueueVerdict", () => {
  it("copies a passing head review as success with a link to the source", () => {
    const verdict = decideQueueVerdict({
      headSha: HEAD,
      headRuns: [run({ id: 5 })],
      reviewAppId: APP,
    });
    expect(verdict).toMatchObject({
      outcome: "copied_success",
      conclusion: "success",
      sourceCheckRunId: 5,
    });
    expect(verdict.summary).toBe(
      `Copied from https://github.com/cogni-dao/cogni/runs/5 at head ${HEAD}`
    );
  });

  it("copies a failed head review as failure", () => {
    const verdict = decideQueueVerdict({
      headSha: HEAD,
      headRuns: [run({ id: 5, conclusion: "failure" })],
      reviewAppId: APP,
    });
    expect(verdict).toMatchObject({
      outcome: "copied_failure",
      conclusion: "failure",
      sourceCheckRunId: 5,
    });
    expect(verdict.summary).toContain("runs/5");
  });

  it("never copies neutral as neutral or pass", () => {
    const verdict = decideQueueVerdict({
      headSha: HEAD,
      headRuns: [run({ id: 5, conclusion: "neutral" })],
      reviewAppId: APP,
    });
    expect(verdict.conclusion).toBe("failure");
    expect(verdict.title).toBe(NOT_REVIEWED_TITLE);
  });

  it("fails NOT REVIEWED AT HEAD when the head has no review check", () => {
    const verdict = decideQueueVerdict({
      headSha: HEAD,
      headRuns: [],
      reviewAppId: APP,
    });
    expect(verdict).toMatchObject({
      outcome: "not_reviewed",
      conclusion: "failure",
      title: "PR Review: NOT REVIEWED AT HEAD",
      sourceCheckRunId: null,
    });
  });

  it("fails NOT REVIEWED when the only passing check was written by a foreign App", () => {
    const verdict = decideQueueVerdict({
      headSha: HEAD,
      headRuns: [run({ id: 5, appId: 777, conclusion: "success" })],
      reviewAppId: APP,
    });
    expect(verdict.outcome).toBe("not_reviewed");
    expect(verdict.conclusion).toBe("failure");
  });

  it("fails NOT REVIEWED while the only review is still running", () => {
    const verdict = decideQueueVerdict({
      headSha: HEAD,
      headRuns: [run({ id: 5, status: "in_progress", conclusion: null })],
      reviewAppId: APP,
    });
    expect(verdict.outcome).toBe("not_reviewed");
  });
});
