// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/chat.completions.bearer-auth`
 * Purpose: Prove that POST /api/v1/chat/completions accepts a real HMAC-signed
 *   machine bearer token through the full resolveRequestIdentity chain.
 *   Guards against auth-resolver regressions on the single most-trafficked
 *   route in the agent-first lane.
 * Scope: Mocks at the leaves only — env, next/headers, getServerSessionUser,
 *   container. Mints a real token via issueAgentApiKey. Sends an invalid body
 *   so the handler short-circuits at the OpenAI-contract validator (400),
 *   avoiding the completion facade's huge dependency graph while still
 *   proving the bearer auth path reached the handler body.
 * Invariants:
 *   - Valid bearer → handler runs, returns 400 for invalid body (NOT 401).
 *   - Session getter is never called when a bearer is present (bearer exclusive).
 *   - Missing credentials → 401 body {error:"Session required"} + bare
 *     `WWW-Authenticate: Bearer` (RFC 6750 §3, missing-credential challenge).
 *   - Expired/invalid bearer → 401 body {error:"invalid_token", error_description}
 *     + `WWW-Authenticate: Bearer error="invalid_token", ...` (RFC 6750 §3);
 *     NEVER falls back to the session cookie (BEARER_CLAIMS_EXCLUSIVE).
 * Side-effects: none (all IO mocked).
 * Links: src/app/api/v1/chat/completions/route.ts,
 *        src/app/_lib/auth/request-identity.ts
 * @public
 */

import { createHmac } from "node:crypto";
import { TEST_USER_ID_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Env must be mocked BEFORE importing anything that calls serverEnv() at
// module load — issueAgentApiKey reads AUTH_SECRET when we mint the token.
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "test-auth-secret-for-unit-tests" }),
}));

vi.mock("@/shared/config", () => ({
  getNodeId: () => "test-node-id",
}));

const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

const mockGetServerSessionUser = vi.fn();
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

vi.mock("@/bootstrap/container", () => ({
  resolveAiAdapterDeps: vi.fn(),
  getTemporalWorkflowClient: vi.fn(),
  getContainer: vi.fn(() => ({
    config: { unhandledErrorPolicy: "rethrow" },
    log: {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    clock: { now: () => new Date("2026-04-13T00:00:00.000Z") },
  })),
}));

// Import AFTER mocks so issueAgentApiKey reads the test secret.
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import * as appHandler from "@/app/api/v1/chat/completions/route";

function headersFromRecord(record: Record<string, string>) {
  const normalized = new Map(
    Object.entries(record).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { get: (name: string) => normalized.get(name.toLowerCase()) ?? null };
}

const TEST_AUTH_SECRET = "test-auth-secret-for-unit-tests";

const VALID_AGENT_TOKEN = issueAgentApiKey({
  userId: TEST_USER_ID_1,
  displayName: "Bearer Test",
});

/**
 * Mint a token with an `exp` in the past using the SAME HMAC-SHA256 scheme as
 * issueAgentApiKey (prefix + base64url(payload) + "." + HMAC(payload)). The
 * signature is VALID; only the expiry is stale — this is the exact shape that
 * previously masked as "Session required" (bug.5069).
 */
function mintExpiredAgentToken(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    sub: TEST_USER_ID_1,
    displayName: "Expired Bearer Test",
    iat: nowSec - 7200,
    exp: nowSec - 3600, // expired an hour ago
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const signature = createHmac("sha256", TEST_AUTH_SECRET)
    .update(payloadB64)
    .digest("base64url");
  return `cogni_ag_sk_v1_${payloadB64}.${signature}`;
}

describe("POST /api/v1/chat/completions — bearer auth via real resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid HMAC-signed bearer and runs the handler body (400 on invalid payload, NOT 401)", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({ authorization: `Bearer ${VALID_AGENT_TOKEN}` })
    );

    await testApiHandler({
      appHandler,
      url: "/api/v1/chat/completions",
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          body: JSON.stringify({}), // missing model + messages → contract 400
          headers: { "content-type": "application/json" },
        });

        // Proof of auth success: status is NOT 401 (wrapper's "Session required")
        // and NOT the generic 500. It IS 400 (OpenAI invalid_request_error from
        // the handler's own contract validation path), which is only reachable
        // AFTER the auth wrapper has resolved a non-null sessionUser.
        expect(res.status).toBe(400);

        // Bearer claim is exclusive — session fallback must NOT be hit.
        expect(mockGetServerSessionUser).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 401 when no credentials are presented (wrapper guard)", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));
    mockGetServerSessionUser.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      url: "/api/v1/chat/completions",
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        });

        expect(res.status).toBe(401);
        // Missing-credential challenge: bare `Bearer`, session-required body.
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
        expect(await res.json()).toEqual({ error: "Session required" });
        // Real resolver chain must have delegated to the leaf session getter.
        expect(mockGetServerSessionUser).toHaveBeenCalledTimes(1);
      },
    });
  });

  it("returns 401 invalid_token + WWW-Authenticate for an EXPIRED bearer (bug.5069)", async () => {
    const expiredToken = mintExpiredAgentToken();
    mockHeaders.mockResolvedValue(
      headersFromRecord({ authorization: `Bearer ${expiredToken}` })
    );

    await testApiHandler({
      appHandler,
      url: "/api/v1/chat/completions",
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        });

        expect(res.status).toBe(401);

        // RFC 6750 §3: presented-but-invalid credential → machine-readable
        // `invalid_token` code + a description that distinguishes expiry.
        const wwwAuth = res.headers.get("www-authenticate");
        expect(wwwAuth).toContain('error="invalid_token"');
        expect(wwwAuth).toContain("expired");

        const json = await res.json();
        expect(json.error).toBe("invalid_token");
        expect(json.error_description).toBe("The access token expired");

        // BEARER_CLAIMS_EXCLUSIVE: an invalid bearer never falls back to the
        // session cookie, so the leaf session getter is never consulted.
        expect(mockGetServerSessionUser).not.toHaveBeenCalled();
      },
    });
  });
});
