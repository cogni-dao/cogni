// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/review/candidate-backlog-source.adapter.test`
 * Purpose: Pin the candidate backlog GitHub source (task.5498) over a fake Octokit: drafts are dropped, a next page
 *   is `truncated`, a head is green only when every suite completed green (at the latest suite instant), a head
 *   whose suites did not fit is `incomplete`, and bad input never reaches GitHub.
 * Side-effects: none
 */

import { describe, expect, it, vi } from "vitest";
import {
  GitHubCandidateBacklogSource,
  greenInstant,
  mapOpenPulls,
} from "./candidate-backlog-source.adapter";

const REPO = { owner: "cogni-dao", repo: "node-template" };
const SHA = "a".repeat(40);
const signal = new AbortController().signal;

const source = (request: ReturnType<typeof vi.fn>) =>
  new GitHubCandidateBacklogSource(
    { appId: "1", privateKeyBase64: "x" },
    () => new Date("2026-11-18T12:00:00Z"),
    // biome-ignore lint/suspicious/noExplicitAny: Octokit test double
    { request } as any
  );

describe("mapOpenPulls", () => {
  it("keeps non-draft PRs with a head sha, lowercased, and drops drafts and malformed nodes", () => {
    expect(
      mapOpenPulls([
        {
          number: 1,
          draft: false,
          created_at: "2026-11-01T00:00:00Z",
          head: { sha: "A".repeat(40) },
        },
        {
          number: 2,
          draft: true,
          created_at: "2026-11-01T00:00:00Z",
          head: { sha: SHA },
        },
        { number: 3, created_at: "2026-11-02T00:00:00Z", head: { sha: SHA } },
        { number: 4, draft: false, created_at: "2026-11-02T00:00:00Z" },
        {
          draft: false,
          created_at: "2026-11-02T00:00:00Z",
          head: { sha: SHA },
        },
      ]).map((p) => [p.number, p.headSha])
    ).toEqual([
      [1, SHA],
      [3, SHA],
    ]);
  });
});

describe("greenInstant", () => {
  const suite = (
    conclusion: string | null,
    updated: string,
    status = "completed"
  ) => ({
    status,
    conclusion,
    updated_at: updated,
  });
  it("is the latest suite instant when every suite completed success, neutral or skipped", () => {
    expect(
      greenInstant([
        suite("success", "2026-11-18T10:00:00Z"),
        suite("neutral", "2026-11-18T11:00:00Z"),
        suite("skipped", "2026-11-18T09:00:00Z"),
      ])?.toISOString()
    ).toBe("2026-11-18T11:00:00.000Z");
  });
  it("is undefined with no suites, a pending suite, or any failing conclusion", () => {
    expect(greenInstant([])).toBeUndefined();
    expect(
      greenInstant([suite(null, "2026-11-18T10:00:00Z", "in_progress")])
    ).toBeUndefined();
    expect(
      greenInstant([
        suite("success", "2026-11-18T10:00:00Z"),
        suite("failure", "2026-11-18T10:05:00Z"),
      ])
    ).toBeUndefined();
    expect(
      greenInstant([suite("action_required", "2026-11-18T10:00:00Z")])
    ).toBeUndefined();
    expect(greenInstant([suite("success", "not a date")])).toBeUndefined();
  });
});

describe("GitHubCandidateBacklogSource", () => {
  it("openPullRequests: one open-state read, drafts dropped, `next` link = truncated", async () => {
    const request = vi.fn(async (..._a: unknown[]) => ({
      data: [
        {
          number: 1,
          draft: false,
          created_at: "2026-11-01T00:00:00Z",
          head: { sha: SHA },
        },
        {
          number: 2,
          draft: true,
          created_at: "2026-11-01T00:00:00Z",
          head: { sha: SHA },
        },
      ],
      headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
    }));
    const out = await source(request).openPullRequests({
      repo: REPO,
      maxPrs: 100,
      signal,
    });
    expect(out.prs.map((p) => p.number)).toEqual([1]);
    expect(out.truncated).toBe(true);
    expect(out.asOf.toISOString()).toBe("2026-11-18T12:00:00.000Z");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("GET /repos/{owner}/{repo}/pulls");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      owner: "cogni-dao",
      repo: "node-template",
      state: "open",
      per_page: 100,
    });
    const last = await source(
      vi.fn(async (..._a: unknown[]) => ({ data: [], headers: {} }))
    ).openPullRequests({ repo: REPO, maxPrs: 100, signal });
    expect(last).toMatchObject({ prs: [], truncated: false });
  });

  it("ciGreenAt: one check-suites read of the head; green, pending and incomplete", async () => {
    const request = vi.fn(async (..._a: unknown[]) => ({
      data: {
        total_count: 2,
        check_suites: [
          {
            status: "completed",
            conclusion: "success",
            updated_at: "2026-11-18T10:00:00Z",
          },
          {
            status: "completed",
            conclusion: "success",
            updated_at: "2026-11-18T10:30:00Z",
          },
        ],
      },
      headers: {},
    }));
    const green = await source(request).ciGreenAt({
      repo: REPO,
      headSha: SHA,
      signal,
    });
    expect(green.green?.toISOString()).toBe("2026-11-18T10:30:00.000Z");
    expect(green.incomplete).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-suites"
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      ref: SHA,
      per_page: 100,
    });

    const partial = await source(
      vi.fn(async (..._a: unknown[]) => ({
        data: {
          total_count: 150,
          check_suites: [
            {
              status: "completed",
              conclusion: "success",
              updated_at: "2026-11-18T10:00:00Z",
            },
          ],
        },
        headers: {},
      }))
    ).ciGreenAt({ repo: REPO, headSha: SHA, signal });
    expect(partial.incomplete).toBe(true);

    const pending = await source(
      vi.fn(async (..._a: unknown[]) => ({
        data: {
          total_count: 1,
          check_suites: [
            {
              status: "in_progress",
              conclusion: null,
              updated_at: "2026-11-18T10:00:00Z",
            },
          ],
        },
        headers: {},
      }))
    ).ciGreenAt({ repo: REPO, headSha: SHA, signal });
    expect(pending.green).toBeUndefined();
  });

  it("a GitHub error propagates (the reading becomes unavailable, never 0)", async () => {
    const request = vi.fn(async (..._a: unknown[]) => {
      throw new Error("HTTP 403");
    });
    await expect(
      source(request).openPullRequests({ repo: REPO, maxPrs: 100, signal })
    ).rejects.toThrow("HTTP 403");
  });

  it("rejects a bad head sha and an aborted signal before any request", async () => {
    const request = vi.fn();
    await expect(
      source(request).ciGreenAt({ repo: REPO, headSha: "main", signal })
    ).rejects.toThrow("candidate_backlog_sha_invalid");
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      source(request).openPullRequests({
        repo: REPO,
        maxPrs: 100,
        signal: aborted.signal,
      })
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("without the test seam, a repo name that is not a safe slug is refused before any network call", async () => {
    const real = new GitHubCandidateBacklogSource({
      appId: "1",
      privateKeyBase64: "x",
    });
    await expect(
      real.openPullRequests({
        repo: { owner: "a/b", repo: "c" },
        maxPrs: 100,
        signal,
      })
    ).rejects.toThrow("candidate_backlog_repo_invalid");
  });
});
