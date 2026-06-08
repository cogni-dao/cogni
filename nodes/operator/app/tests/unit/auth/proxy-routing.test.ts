// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/auth/proxy-routing`
 * Purpose: Unit tests for proxy.ts auth routing — the single authority for redirect logic.
 * Scope: Tests page-level routing (authed on / → /chat, unauthed on app routes → sign-in prompt) and API protection. Does not test NextAuth internals.
 * Invariants: Single authority for auth routing; no client-side redirect logic.
 * Side-effects: none (mocked getToken)
 * Links: src/proxy.ts, docs/spec/security-auth.md
 * @public
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetToken = vi.fn();

vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

vi.mock("@/auth", () => ({
  authSecret: "test-secret",
  authOptions: { secret: "test-secret" },
}));

// Import after mocks
import { proxy } from "@/proxy";

// --- Helpers ---

function makeRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

function makeAgentRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: {
      authorization: "Bearer cogni_ag_sk_v1_test.payload.signature",
    },
  });
}

function expectRedirectTo(res: Response, pathname: string): void {
  expect(res.status).toBe(307);
  const location = res.headers.get("location") ?? "";
  expect(new URL(location).pathname).toBe(pathname);
}

function expectSignInRedirectTo(res: Response, callbackUrl: string): void {
  expect(res.status).toBe(307);
  const location = res.headers.get("location") ?? "";
  const url = new URL(location);
  expect(url.pathname).toBe("/");
  expect(url.searchParams.get("signIn")).toBe("1");
  expect(url.searchParams.get("callbackUrl")).toBe(callbackUrl);
}

// --- Tests ---

describe("proxy — page-level routing", () => {
  beforeEach(() => {
    mockGetToken.mockReset();
  });

  it("redirects authenticated user on / to /chat", async () => {
    mockGetToken.mockResolvedValue({ id: "user-1" });

    const res = await proxy(makeRequest("/"));

    expectRedirectTo(res, "/chat");
  });

  it("passes through unauthenticated user on /", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/"));

    expect(res.status).toBe(200);
  });

  it("redirects unauthenticated user on /nodes to sign-in with callback", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/nodes"));

    expectSignInRedirectTo(res, "/nodes");
  });

  it("passes through authenticated user on /nodes", async () => {
    mockGetToken.mockResolvedValue({ id: "user-1" });

    const res = await proxy(makeRequest("/nodes"));

    expect(res.status).toBe(200);
  });

  it("passes through public /explore/nodes without checking auth", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/explore/nodes"));

    expect(res.status).toBe(200);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated user on /chat to sign-in with callback", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/chat"));

    expectSignInRedirectTo(res, "/chat");
  });

  it("redirects unauthenticated user on /profile to sign-in with callback", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/profile"));

    expectSignInRedirectTo(res, "/profile");
  });

  it.each([
    "/dashboard",
    "/knowledge",
    "/knowledge/entry-1",
    "/nodes/payments",
    "/nodes/11111111-1111-4111-8111-111111111111",
  ])("redirects unauthenticated user on %s to sign-in with callback", async (path) => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest(path));

    expectSignInRedirectTo(res, path);
  });

  it("preserves query params in app-route sign-in callbacks", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/nodes/payments?nodeId=node-1"));

    expectSignInRedirectTo(res, "/nodes/payments?nodeId=node-1");
  });

  it("redirects unauthenticated user on /chat/some-id to sign-in with callback", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/chat/some-id"));

    expectSignInRedirectTo(res, "/chat/some-id");
  });

  it("passes through authenticated user on /chat", async () => {
    mockGetToken.mockResolvedValue({ id: "user-1" });

    const res = await proxy(makeRequest("/chat"));

    expect(res.status).toBe(200);
  });

  it("passes through authenticated user on /profile", async () => {
    mockGetToken.mockResolvedValue({ id: "user-1" });

    const res = await proxy(makeRequest("/profile"));

    expect(res.status).toBe(200);
  });

  it.each([
    "/dashboard",
    "/knowledge",
    "/knowledge/entry-1",
    "/nodes/payments",
    "/nodes/11111111-1111-4111-8111-111111111111",
  ])("passes through authenticated user on %s", async (path) => {
    mockGetToken.mockResolvedValue({ id: "user-1" });

    const res = await proxy(makeRequest(path));

    expect(res.status).toBe(200);
  });
});

describe("proxy — API route protection", () => {
  beforeEach(() => {
    mockGetToken.mockReset();
  });

  it("allows /api/v1/public/* without auth", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/api/v1/public/health"));

    expect(res.status).toBe(200);
    // getToken should not even be called for public routes
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("allows /api/v1/agent/register without auth", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/api/v1/agent/register"));

    expect(res.status).toBe(200);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated on /api/v1/*", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeRequest("/api/v1/users/me"));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("allows authenticated on /api/v1/*", async () => {
    mockGetToken.mockResolvedValue({ id: "user-1" });

    const res = await proxy(makeRequest("/api/v1/users/me"));

    expect(res.status).toBe(200);
  });

  it("allows agent bearer on /api/v1/chat/completions", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeAgentRequest("/api/v1/chat/completions"));

    expect(res.status).toBe(200);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("allows agent bearer on /api/v1/agent/runs", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeAgentRequest("/api/v1/agent/runs"));

    expect(res.status).toBe(200);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("allows agent bearer on /api/v1/ai/chat (agent-first)", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeAgentRequest("/api/v1/ai/chat"));

    expect(res.status).toBe(200);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("allows agent bearer on /api/v1/ai/models (agent-first)", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeAgentRequest("/api/v1/ai/models"));

    expect(res.status).toBe(200);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("allows agent bearer on /api/v1/schedules/* (agent-first)", async () => {
    mockGetToken.mockResolvedValue(null);

    const res = await proxy(makeAgentRequest("/api/v1/schedules/my-schedule"));

    expect(res.status).toBe(200);
    expect(mockGetToken).not.toHaveBeenCalled();
  });
});

describe("proxy — unmatched routes", () => {
  beforeEach(() => {
    mockGetToken.mockReset();
  });

  it("passes through unmatched routes without checking auth", async () => {
    // Routes not in APP_ROUTES and not /api/v1/* should pass through
    const res = await proxy(makeRequest("/api/auth/callback/github"));

    expect(res.status).toBe(200);
    // getToken should not be called for non-auth routes
    expect(mockGetToken).not.toHaveBeenCalled();
  });
});
