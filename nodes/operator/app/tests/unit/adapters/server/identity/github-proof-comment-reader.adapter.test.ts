// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Unit tests for the GitHub proof-comment reader at its fetch seam (task.0095): what is evidence and what is not. */

import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_COMMENT_MAX_BODY_BYTES,
  GithubAppProofCommentReader,
  PROOF_READ_PERMISSIONS,
} from "@/adapters/server/identity/github-proof-comment-reader.adapter";

const REPO = { owner: "cogni-dao", name: "node-template" };
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

function reader(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
) {
  const fetchMock = vi.fn(fetchImpl);
  const getToken = vi.fn(async () => "installation-token");
  return {
    fetchMock,
    getToken,
    reader: new GithubAppProofCommentReader({
      appId: "1",
      privateKey: "unused",
      fetch: fetchMock as unknown as typeof fetch,
      getToken,
    }),
  };
}

describe("GithubAppProofCommentReader", () => {
  it("asks for the smallest grant: metadata read only", () => {
    expect(PROOF_READ_PERMISSIONS).toEqual({ metadata: "read" });
  });

  it("reads one comment from a URL built from owner, name and an integer, with redirect:error and a timeout", async () => {
    const t = reader(async () =>
      json({
        node_id: "IC_1",
        issue_url:
          "https://api.github.com/repos/cogni-dao/node-template/issues/341",
        user: { id: 12345, type: "User", login: "an-agent" },
        body: "cogni-proof:v1:x",
        created_at: "2026-11-11T20:00:00Z",
        updated_at: "2026-11-11T20:00:00Z",
      })
    );
    const out = await t.reader.readIssueComment(REPO, 4_000_000_001);
    expect(out).toMatchObject({
      kind: "ok",
      value: {
        nodeId: "IC_1",
        userId: 12345,
        userType: "User",
        login: "an-agent",
      },
    });
    const [url, init] = t.fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/cogni-dao/node-template/issues/comments/4000000001"
    );
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(t.getToken.mock.calls)).toContain("node-template");
  });

  it("a 404 is evidence (value null); 403 without a rate-limit header, 5xx, a timeout and a bad body are errors, never a 404", async () => {
    expect(
      await reader(
        async () => new Response("{}", { status: 404 })
      ).reader.readIssueComment(REPO, 1)
    ).toEqual({ kind: "ok", value: null });
    expect(
      await reader(
        async () => new Response("{}", { status: 403 })
      ).reader.readIssueComment(REPO, 1)
    ).toEqual({ kind: "error", reasonCode: "http_403", status: 403 });
    expect(
      await reader(
        async () => new Response("{}", { status: 502 })
      ).reader.readIssueComment(REPO, 1)
    ).toEqual({ kind: "error", reasonCode: "http_5xx", status: 502 });
    expect(
      await reader(async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      }).reader.readIssueComment(REPO, 1)
    ).toEqual({ kind: "error", reasonCode: "timeout", status: null });
    expect(
      await reader(
        async () => new Response("not json")
      ).reader.readIssueComment(REPO, 1)
    ).toEqual({ kind: "error", reasonCode: "bad_body", status: 200 });
    expect(
      await reader(async () => json({ node_id: "x" })).reader.readIssueComment(
        REPO,
        1
      )
    ).toMatchObject({ kind: "error", reasonCode: "bad_body" });
  });

  it("rate limit: 429, or 403 with x-ratelimit-remaining 0 or retry-after, is rate_limited with the reset time", async () => {
    const limited = await reader(
      async () =>
        new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1800000000",
          },
        })
    ).reader.readIssueComment(REPO, 1);
    expect(limited).toEqual({ kind: "rate_limited", resetAt: 1_800_000_000 });
    expect(
      (
        await reader(
          async () => new Response("{}", { status: 429 })
        ).reader.repositoryIsPrivate(REPO)
      ).kind
    ).toBe("rate_limited");
    expect(
      (
        await reader(async () =>
          json({ errors: [{ type: "RATE_LIMITED" }] })
        ).reader.repositoryIsPrivate(REPO)
      ).kind
    ).toBe("rate_limited");
  });

  it("caps the body at 256 KB (declared or streamed)", async () => {
    const declared = await reader(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-length": String(GITHUB_COMMENT_MAX_BODY_BYTES + 1),
          },
        })
    ).reader.readIssueComment(REPO, 1);
    expect(declared).toMatchObject({ kind: "error", reasonCode: "too_large" });
    const streamed = await reader(
      async () => new Response("a".repeat(GITHUB_COMMENT_MAX_BODY_BYTES + 10))
    ).reader.readIssueComment(REPO, 1);
    expect(streamed).toMatchObject({ kind: "error", reasonCode: "too_large" });
  });

  it("visibility: isPrivate false and true pass through; an invisible repository is null; a missing field is an error", async () => {
    const vis = (body: unknown) =>
      reader(async () => json(body)).reader.repositoryIsPrivate(REPO);
    expect(await vis({ data: { repository: { isPrivate: false } } })).toEqual({
      kind: "ok",
      value: false,
    });
    expect(await vis({ data: { repository: { isPrivate: true } } })).toEqual({
      kind: "ok",
      value: true,
    });
    expect(
      await vis({ data: { repository: null }, errors: [{ type: "NOT_FOUND" }] })
    ).toEqual({ kind: "ok", value: null });
    expect(await vis({ data: { repository: {} } })).toMatchObject({
      kind: "error",
      reasonCode: "bad_body",
    });
  });

  it("lastEditedAt: null = never edited, a string = edited, a missing node = null value, a missing field is an error", async () => {
    const edited = (body: unknown) =>
      reader(async () => json(body)).reader.readCommentLastEditedAt(
        REPO,
        "IC_1"
      );
    expect(await edited({ data: { node: { lastEditedAt: null } } })).toEqual({
      kind: "ok",
      value: { lastEditedAt: null },
    });
    expect(
      await edited({ data: { node: { lastEditedAt: "2026-11-11T20:00:00Z" } } })
    ).toEqual({ kind: "ok", value: { lastEditedAt: "2026-11-11T20:00:00Z" } });
    expect(await edited({ data: { node: null } })).toEqual({
      kind: "ok",
      value: null,
    });
    expect(await edited({ data: { node: {} } })).toMatchObject({
      kind: "error",
      reasonCode: "bad_body",
    });
  });

  it("a token failure is an auth error and makes no GitHub request", async () => {
    const fetchMock = vi.fn();
    const r = new GithubAppProofCommentReader({
      appId: "1",
      privateKey: "unused",
      fetch: fetchMock as unknown as typeof fetch,
      getToken: async () => {
        throw new Error("no installation");
      },
    });
    expect(await r.readIssueComment(REPO, 1)).toEqual({
      kind: "error",
      reasonCode: "auth",
      status: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
