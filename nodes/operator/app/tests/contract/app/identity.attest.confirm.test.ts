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

import { createHash } from "node:crypto";
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
const config = vi.hoisted(() => ({
  origin: "https://cognidao.org" as string | undefined,
}));

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    ...MOCK_SERVER_ENV,
    APP_BASE_URL: config.origin,
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

function currentBinding(): string {
  const token = cookieStore.store.get(BROKER_STATE_COOKIE) ?? "";
  return createHash("sha256")
    .update("identity-broker-consent-v1\0")
    .update(token)
    .digest("hex");
}

function request(action?: string): NextRequest {
  const body = new FormData();
  if (action) body.set("action", action);
  body.set("consentBinding", currentBinding());
  return new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
    method: "POST",
    headers: { Origin: "https://cognidao.org" },
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
    config.origin = "https://cognidao.org";
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
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://cognidao.org",
        },
        body: `consentBinding=${currentBinding()}&action=${value}`,
      })
    );
    expect(res.headers.get("location")).toContain("code=invalid_request");
    expect(mockIssue).not.toHaveBeenCalled();
    expect(cookieStore.delete.mock.calls.length).toBe(0);
  });

  it("rejects a file action", async () => {
    await seed();
    const body = new FormData();
    body.append("action", new File(["confirm"], "action.txt"));
    body.set("consentBinding", currentBinding());
    const res = await POST(
      new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
        method: "POST",
        headers: { Origin: "https://cognidao.org" },
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
        headers: {
          "Content-Type": "multipart/form-data",
          Origin: "https://cognidao.org",
        },
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

async function renderedBinding(): Promise<string> {
  const { default: Page } = await import("@/app/identity/attest/confirm/page");
  function find(node: unknown): string | undefined {
    if (!node || typeof node !== "object") return;
    const props = (
      node as { props?: { consentBinding?: unknown; children?: unknown } }
    ).props;
    if (typeof props?.consentBinding === "string") return props.consentBinding;
    for (const child of Array.isArray(props?.children)
      ? props.children
      : [props?.children]) {
      const value = find(child);
      if (value) return value;
    }
  }
  const result = find(await Page());
  if (!result) throw new Error("page did not render consent binding");
  return result;
}

describe("consent snapshot refusal regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.origin = "https://cognidao.org";
    cookieStore.store.clear();
    mockIssue.mockResolvedValue({
      redirectUrl: "https://fixture.example/#attestation=fixture",
    });
  });

  it.each([
    "confirm",
    "cancel",
    "switch",
    "invalid",
  ])("preserves B when a stale A submits %s", async (action) => {
    await seed();
    const binding = await renderedBinding();
    await seed({ ...AUTHENTICATED, github: { id: "9", login: "fixture-b" } });
    const b = cookieStore.store.get(BROKER_STATE_COOKIE);
    const body = new FormData();
    body.set("action", action);
    body.set("consentBinding", binding);
    await POST(
      new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
        method: "POST",
        headers: { Origin: "https://cognidao.org" },
        body,
      })
    );
    expect(mockIssue).not.toHaveBeenCalled();
    expect(cookieStore.set.mock.calls.length).toBe(0);
    expect(cookieStore.delete.mock.calls.length).toBe(0);
    expect(cookieStore.store.get(BROKER_STATE_COOKIE)).toBe(b);
  });
  it("refuses a foreign Origin with a valid current binding", async () => {
    await seed();
    const cookie = cookieStore.store.get(BROKER_STATE_COOKIE) as string;
    const body = new FormData();
    body.set("action", "confirm");
    body.set(
      "consentBinding",
      createHash("sha256")
        .update("identity-broker-consent-v1\0")
        .update(cookie)
        .digest("hex")
    );
    await POST(
      new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body,
      })
    );
    expect(mockIssue).not.toHaveBeenCalled();
    expect(cookieStore.delete.mock.calls.length).toBe(0);
    expect(cookieStore.store.get(BROKER_STATE_COOKIE)).toBe(cookie);
  });
});

describe("native consent security boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.origin = "https://cognidao.org";
    cookieStore.store.clear();
    mockIssue.mockResolvedValue({
      redirectUrl: "https://fixture.example/#attestation=fixture",
    });
  });

  const makePost = (body: FormData, origin?: string) =>
    new NextRequest("https://cognidao.org/api/auth/attest/confirm", {
      method: "POST",
      headers:
        origin === undefined
          ? {}
          : {
              Origin: origin,
              Host: "cognidao.org",
              "X-Forwarded-Host": "cognidao.org",
            },
      body,
    });
  const bodyWith = (binding: string) => {
    const body = new FormData();
    body.set("action", "confirm");
    body.set("consentBinding", binding);
    return body;
  };
  const preserved = (original: string | undefined) => {
    expect(mockIssue).not.toHaveBeenCalled();
    expect(cookieStore.set.mock.calls.length).toBe(0);
    expect(cookieStore.delete.mock.calls.length).toBe(0);
    expect(cookieStore.store.get(BROKER_STATE_COOKIE) === original).toBe(true);
  };

  it.each([
    undefined,
    "null",
    "https://evil.example",
    "https://sibling.cognidao.org",
    "http://cognidao.org",
    "https://cognidao.org:444",
    "https://cognidao.org:443",
    "https://cognidao.org/path",
    "https://cognidao.org, https://evil.example",
  ])("refuses Origin %s without mutation", async (origin) => {
    await seed();
    const token = cookieStore.store.get(BROKER_STATE_COOKIE);
    const res = await POST(makePost(bodyWith(currentBinding()), origin));
    expect(res.status).toBe(403);
    preserved(token);
  });
  it.each([
    undefined,
    "http://cognidao.org",
    "https://cognidao.org/path",
    "https://cognidao.org:443",
  ])("refuses invalid configured base %s locally", async (base) => {
    await seed();
    const token = cookieStore.store.get(BROKER_STATE_COOKIE);
    config.origin = base;
    const res = await POST(
      makePost(bodyWith(currentBinding()), "https://cognidao.org")
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    preserved(token);
  });
  it("accepts an exact configured nondefault port without Fetch Metadata", async () => {
    await seed();
    config.origin = "https://cognidao.org:444";
    const res = await POST(makePost(bodyWith(currentBinding()), config.origin));
    expect(res.status).toBe(303);
    expect(mockIssue).toHaveBeenCalledOnce();
  });
  it.each([
    "missing",
    "duplicate",
    "file",
    "malformed",
    "forged",
  ])("preserves the cookie for %s binding", async (kind) => {
    await seed();
    const token = cookieStore.store.get(BROKER_STATE_COOKIE);
    const body = bodyWith(currentBinding());
    if (kind === "missing") body.delete("consentBinding");
    if (kind === "duplicate") body.append("consentBinding", currentBinding());
    if (kind === "file")
      body.set("consentBinding", new File(["a"], "binding.txt"));
    if (kind === "malformed") body.set("consentBinding", "A".repeat(64));
    if (kind === "forged") body.set("consentBinding", "a".repeat(64));
    const res = await POST(makePost(body, "https://cognidao.org"));
    expect(res.headers.get("location")).toContain("consent_review_required");
    preserved(token);
  });
  it("extracts the binding from the actual page and correlates it to the cookie", async () => {
    await seed();
    const binding = await renderedBinding();
    expect(binding).toBe(currentBinding());
    expect(binding).not.toBe(cookieStore.store.get(BROKER_STATE_COOKIE));
    const result = await POST(
      makePost(bodyWith(binding as string), "https://cognidao.org")
    );
    expect(result.status).toBe(303);
    expect(mockIssue).toHaveBeenCalledOnce();
  });
  it.each([
    "confirm",
    "cancel",
    "switch",
  ])("accepts the current B page for %s", async (action) => {
    await seed();
    await seed({ ...AUTHENTICATED, github: { id: "9", login: "fixture-b" } });
    const body = bodyWith(await renderedBinding());
    body.set("action", action);
    const response = await POST(makePost(body, "https://cognidao.org"));
    expect(response.status).toBe(303);
    if (action === "confirm")
      expect(mockIssue).toHaveBeenCalledWith(
        expect.objectContaining({ github: { id: "9", login: "fixture-b" } })
      );
    else expect(mockIssue).not.toHaveBeenCalled();
    if (action === "cancel")
      expect(response.headers.get("location")).toContain("cancelled");
    if (action === "switch")
      expect(
        (
          await decodeBrokerState(
            cookieStore.store.get(BROKER_STATE_COOKIE),
            SECRET
          )
        )?.github
      ).toBeUndefined();
  });

  it.each([
    { provider: "other" },
    { state: "new-state" },
    { codeVerifier: "new-verifier" },
    { nodeId: "33333333-3333-4333-8333-333333333333" },
    { nodeSlug: "another" },
    { nonce: "different_node_generated_nonce_0123456789" },
    { targetOrigin: "https://another.example" },
    { returnTo: "https://another.example/profile" },
    { github: { id: "7", login: "another" } },
    {},
  ])("rejects an old render after cookie replacement %#", async (change) => {
    await seed();
    const binding = await renderedBinding();
    await seed({ ...AUTHENTICATED, ...change });
    const token = cookieStore.store.get(BROKER_STATE_COOKIE);
    const response = await POST(
      makePost(bodyWith(binding), "https://cognidao.org")
    );
    expect(response.headers.get("location")).toContain(
      "consent_review_required"
    );
    preserved(token);
  });

  it("configures enforced frame protection on the whole consent document path", async () => {
    const { default: configFile } = await import("../../../next.config");
    const rules = await configFile.headers?.();
    const rule = rules?.find(
      (entry) => entry.source === "/identity/attest/confirm"
    );
    expect(rule?.headers).toEqual(
      expect.arrayContaining([
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ])
    );
  });
});
