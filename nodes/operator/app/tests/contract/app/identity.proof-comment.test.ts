// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/identity.proof-comment`
 * Purpose: Contract tests for POST /api/v1/public/identity/proof-comment (task.0095).
 * Scope: Strict request, status mapping, no-store, the per-client bucket keyed on cf-connecting-ip, and the terminal event (no secret, no nonce).
 *   The policy itself is covered by tests/unit/features/identity/read-proof-comment.test.ts. Fully mocked facade.
 * Side-effects: none
 * Links: src/app/api/v1/public/identity/proof-comment/route.ts
 * @public
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "request_nonce_0123456789abcdef_ABCDEF";

const issue = vi.hoisted(() => vi.fn());
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@/shared/env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => MOCK_SERVER_ENV,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: { ...log, child: vi.fn(() => log) },
    clock: { now: vi.fn(() => new Date("2026-11-11T20:00:00Z")) },
    config: {
      DEPLOY_ENVIRONMENT: "test",
      rateLimitBypass: { enabled: false, headerName: "", headerValue: "" },
      unhandledErrorPolicy: "rethrow",
    },
  })),
}));
vi.mock("@/app/_facades/identity/proof-comment.server", () => ({
  issueProofCommentAttestation: issue,
}));
// The route's own client bucket (2 per client), real keying on cf-connecting-ip.
vi.mock("@/bootstrap/proof-comment", async () => {
  const { TokenBucketRateLimiter } = await import(
    "@/bootstrap/http/rateLimiter"
  );
  return {
    proofCommentClientLimiter: new TokenBucketRateLimiter({
      maxTokens: 2,
      refillRate: 0,
      burstSize: 0,
    }),
  };
});

import { POST } from "@/app/api/v1/public/identity/proof-comment/route";

let client = 0;
function post(body: unknown, headers: Record<string, string> = {}) {
  client += 1;
  return POST(
    new NextRequest(
      "http://localhost:3000/api/v1/public/identity/proof-comment",
      {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `203.0.113.${client}`,
          ...headers,
        },
      }
    )
  );
}

const valid = {
  nodeId: NODE_ID,
  requestNonce: NONCE,
  issue: "cogni-dao/node-template#341",
  commentId: 4_000_000_001,
};

describe("POST /api/v1/public/identity/proof-comment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("200 answers only the signed attestation, no-store, and logs one issued event with the caller request id and no nonce", async () => {
    issue.mockResolvedValue({
      ok: true,
      attestation: "signed.jwt.token",
      expiresIn: 120,
      result: "found",
      userType: "User",
      githubId: 12345,
      edited: false,
      cache: "miss",
    });
    const res = await post(valid, { "x-request-id": "node-req-1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ attestation: "signed.jwt.token" });
    expect(issue).toHaveBeenCalledWith(valid, expect.any(Object));
    const issued = log.info.mock.calls.filter(
      ([f]) => f?.event === "identity.proof_comment.issued"
    );
    expect(issued).toHaveLength(1);
    expect(issued[0]?.[0]).toMatchObject({
      nodeId: NODE_ID,
      result: "found",
      githubId: 12345,
      cache: "miss",
      callerReqId: "node-req-1",
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(NONCE);
  });

  it.each([
    [{ ...valid, challengeSecret: "x".repeat(43) }],
    [{ ...valid, targetOrigin: "https://cognidao.org" }],
    [{ ...valid, requestNonce: "short" }],
    [{ ...valid, commentId: 0 }],
    [{ nodeId: NODE_ID }],
    ["not json"],
    ["x".repeat(3000)],
  ])("400 invalid_request for a body outside the strict shape, before any service call", async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(issue).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "identity.proof_comment.refused",
        errorCode: "invalid_request",
      }),
      "identity.proof_comment.refused"
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("xxxxxxxx");
  });

  it.each([
    ["unknown_node", 404],
    ["repo_not_allowed", 400],
    ["rate_limited", 429],
    ["github_unavailable", 503],
    ["signing_unavailable", 503],
  ] as const)("%s maps to %i and logs one refused event", async (code, status) => {
    issue.mockResolvedValue({ ok: false, code });
    const res = await post(valid);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
    expect(res.headers.get("cache-control")).toBe("no-store");
    if (code === "rate_limited")
      expect(res.headers.get("retry-after")).toBe("60");
    const refused = log.info.mock.calls.filter(
      ([f]) => f?.event === "identity.proof_comment.refused"
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.[0]).toMatchObject({ nodeId: NODE_ID, errorCode: code });
  });

  it("F6 isolation: a client over its own bucket gets 429 without reaching the service; another client behind the same x-real-ip still gets 200", async () => {
    issue.mockResolvedValue({
      ok: true,
      attestation: "t",
      expiresIn: 120,
      result: "not_found",
      userType: null,
      githubId: null,
      edited: false,
      cache: "hit",
    });
    const same = {
      "cf-connecting-ip": "198.51.100.9",
      "x-real-ip": "10.0.0.1",
    };
    expect((await post(valid, same)).status).toBe(200);
    expect((await post(valid, same)).status).toBe(200);
    expect((await post(valid, same)).status).toBe(429);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(
      (
        await post(valid, {
          "cf-connecting-ip": "198.51.100.10",
          "x-real-ip": "10.0.0.1",
        })
      ).status
    ).toBe(200);
  });
});
