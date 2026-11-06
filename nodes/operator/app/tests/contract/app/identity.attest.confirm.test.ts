// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/identity.attest.confirm`
 * Purpose: Contract tests for the terminal confirm leg of the identity broker.
 * Scope: Validates that signing requires an explicit confirmation of an
 *   already-authenticated GitHub account, and that switch/cancel never sign.
 * Invariants: CONFIRM_BEFORE_SIGN; the signed subject is the one the callback
 *   recorded, never an operator session; terminal responses clear the browser cookie.
 * Side-effects: none (fully mocked)
 * Links: /api/auth/attest/confirm route, task.5024
 * @public
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = vi.hoisted(() => ({
  store: new Map<string, string>(),
  get: vi.fn((name: string) => {
    const value = cookieStore.store.get(name);
    return value === undefined ? undefined : { name, value };
  }),
  set: vi.fn((name: string, value: string) => {
    cookieStore.store.set(name, value);
  }),
  delete: vi.fn((name: string) => {
    cookieStore.store.delete(name);
  }),
}));
const mockIssue = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    ...MOCK_SERVER_ENV,
    APP_BASE_URL: "https://cognidao.org",
    GH_IDENTITY_OAUTH_CLIENT_ID: "client-id",
    GH_IDENTITY_OAUTH_CLIENT_SECRET: "client-secret",
    isProd: false,
  }),
}));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({ ...MOCK_SERVER_ENV, isProd: false }),
}));
vi.mock("@/auth", () => ({ authSecret: "test-secret-0123456789abcdef" }));
vi.mock("@/app/_facades/identity/attestation-broker.server", async (orig) => ({
  ...(await orig<
    typeof import("@/app/_facades/identity/attestation-broker.server")
  >()),
  issueBrowserIdentityAttestation: mockIssue,
}));
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: { consume: vi.fn(() => true) },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));

import { POST } from "@/app/api/auth/attest/confirm/route";
import {
  BROKER_STATE_COOKIE,
  decodeBrokerState,
  encodeBrokerState,
} from "@/shared/identity/broker-state";

const SECRET = "test-secret-0123456789abcdef";
const GITHUB = { id: "295942454", login: "flock-leader" };
const AUTHENTICATED = {
  provider: "github",
  state: "correlation-state",
  codeVerifier: "pkce-verifier",
  nodeId: "22222222-2222-4222-8222-222222222222",
  nodeSlug: "node-template",
  nonce: "node_generated_nonce_0123456789abcdef",
  targetOrigin: "https://node-template-test.cognidao.org",
  returnTo: "https://node-template-test.cognidao.org/profile",
  github: GITHUB,
};

function request(action?: string): NextRequest {
  const body = new FormData();
  if (action) body.set("action", action);
  return new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
    method: "POST",
    body,
  });
}

async function seed(
  state: Record<string, unknown> = AUTHENTICATED
): Promise<void> {
  cookieStore.store.set(
    BROKER_STATE_COOKIE,
    await encodeBrokerState(
      state as Parameters<typeof encodeBrokerState>[0],
      SECRET
    )
  );
}

describe("/api/auth/attest/confirm contract tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore.store.clear();
    mockIssue.mockResolvedValue({
      redirectUrl: `${AUTHENTICATED.returnTo}#attestation=signed.jwt`,
    });
  });

  it("signs the confirmed GitHub account and returns it to the node origin", async () => {
    await seed();

    const res = await POST(request("confirm"));

    expect(mockIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        github: GITHUB,
        returnTo: AUTHENTICATED.returnTo,
        request: expect.objectContaining({
          nodeId: AUTHENTICATED.nodeId,
          nonce: AUTHENTICATED.nonce,
          targetOrigin: AUTHENTICATED.targetOrigin,
        }),
      })
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `${AUTHENTICATED.returnTo}#attestation=signed.jwt`
    );
    // Terminal responses clear the browser cookie; nonce consumption is node-owned.
    expect(cookieStore.delete).toHaveBeenCalledWith(BROKER_STATE_COOKIE);
  });

  it("never signs without an explicit confirm action", async () => {
    await seed();

    const res = await POST(request("cancel"));

    expect(mockIssue).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain(
      "/identity/attest/error?code=cancelled"
    );
    expect(cookieStore.delete).toHaveBeenCalledWith(BROKER_STATE_COOKIE);
  });

  it("never signs when the action is missing entirely", async () => {
    await seed();

    const res = await POST(request());

    expect(res.headers.get("location")).toContain("code=invalid_request");
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "unknown",
    "confirm&action=confirm",
    "confirm&action=cancel",
  ])("rejects invalid URL-encoded actions %s", async (value) => {
    await seed();
    const res = await POST(
      new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `action=${value}`,
      })
    );
    expect(res.headers.get("location")).toContain("code=invalid_request");
    expect(mockIssue).not.toHaveBeenCalled();
    expect(cookieStore.delete).toHaveBeenCalledWith(BROKER_STATE_COOKIE);
  });

  it("rejects a file action", async () => {
    await seed();
    const body = new FormData();
    body.append("action", new File(["confirm"], "action.txt"));
    const res = await POST(
      new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
        method: "POST",
        body,
      })
    );
    expect(res.headers.get("location")).toContain("code=invalid_request");
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("rejects unparsable forms", async () => {
    await seed();
    const res = await POST(
      new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data" },
        body: "bad",
      })
    );
    expect(res.headers.get("location")).toContain("code=invalid_request");
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("never signs before GitHub has authenticated an account", async () => {
    const { github: _omitted, ...pending } = AUTHENTICATED;
    await seed(pending);

    const res = await POST(request("confirm"));

    expect(mockIssue).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain(
      "/identity/attest/error?code=broker_request_expired"
    );
  });

  it("re-authorizes with a fresh state and verifier when switching accounts", async () => {
    await seed();

    const res = await POST(request("switch"));

    expect(mockIssue).not.toHaveBeenCalled();
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize"
    );
    expect(location.searchParams.get("prompt")).toBe("select_account");

    const reissued = await decodeBrokerState(
      cookieStore.store.get(BROKER_STATE_COOKIE),
      SECRET
    );
    // The previously-authenticated account is dropped, and correlation values rotate.
    expect(reissued?.github).toBeUndefined();
    expect(reissued?.state).not.toBe(AUTHENTICATED.state);
    expect(reissued?.codeVerifier).not.toBe(AUTHENTICATED.codeVerifier);
    // ...but the node request being brokered is preserved.
    expect(reissued?.nodeId).toBe(AUTHENTICATED.nodeId);
    expect(reissued?.nonce).toBe(AUTHENTICATED.nonce);
    expect(reissued?.returnTo).toBe(AUTHENTICATED.returnTo);
    expect(location.searchParams.get("state")).toBe(reissued?.state);
  });

  it("rejects a confirm with no pending broker request", async () => {
    const res = await POST(request("confirm"));

    expect(mockIssue).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain(
      "/identity/attest/error?code=broker_request_expired"
    );
  });
});
