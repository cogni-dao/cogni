// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/request-identity`
 * Purpose: Unified request identity resolver — returns a SessionUser for
 *   a valid HMAC-signed machine bearer token (`cogni_ag_sk_v1_...`), a revocable hashed key (the package's `REVOCABLE_KEY_PREFIX` token,
 *   one store lookup), or a browser session cookie. One entry point for all auth surfaces.
 * Scope: Bearer parser + HMAC signer/verifier (issueAgentApiKey exported to
 *   the register route only), and resolveRequestIdentity which
 *   wrapRouteHandlerWithLogging consumes via `auth.getSessionUser`. The v1 path reads no database; only a v2 key
 *   reads the credential store (`verifyRevocableKey`). Session IO happens via getServerSessionUser.
 * Invariants:
 *   - V1_PATH_UNCHANGED (task.5474 C2): `parseAgentToken` and its HMAC/expiry checks are byte-for-byte what they were. A revocable key is routed
 *     BEFORE them by prefix; it never reaches the v1 verifier.
 *   - V1_SUPERSEDED: once the verified v1 identity's user holds a CONFIRMED v2 credential (revoked or not), the request is refused with
 *     `V1SupersededError` (401 `v1_superseded`). Revoking the v2 key therefore cannot revive a leaked v1 key. One store read per v1 request.
 *   - REVOCABLE_STORE_OUTAGE_IS_503: a store failure throws `CredentialStoreUnavailableError` (the route wrapper answers 503), never null (401).
 *   - REVOCABLE_ACTIVE_ONLY: the generic resolver admits only an `active` revocable key. A pending or renew_only key reaches only the
 *     credential routes that opt in through `verifyRevocableKey`. A client over the lookup limit is 429 (`CredentialRateLimitedError`).
 *   - NO_AUTH_CYCLE: imports getServerSessionUser DIRECTLY from @/lib/auth/server.
 *     Must NOT import getSessionUser from @/app/_lib/auth/session (that module
 *     re-exports this resolver and would create unbounded async recursion on
 *     every non-bearer request — candidate-a OOM class of bug).
 *   - BEARER_CLAIMS_EXCLUSIVE: when a bearer token is present but invalid,
 *     returns null (does not fall back to session cookies). Prevents a stolen
 *     cookie from winning when the client claimed machine identity.
 *   - NO_REDOS: extractBearerToken uses startsWith/slice (O(n)), not regex
 *     backtracking. Flagged by SonarQube on the original /^Bearer\s+(.+)$/i.
 * Side-effects: IO (next/headers read, NextAuth session fetch via server.ts).
 * Links: docs/spec/security-auth.md, docs/spec/identity-model.md
 * @public
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import {
  assertV1NotSuperseded,
  CredentialRateLimitedError,
  type CredentialState,
  CredentialStoreUnavailableError,
  isRevocableKey,
  type VerifyResult,
} from "@cogni-dao/agent-grants/credentials";
import { headers } from "next/headers";
import { getServerSessionUser } from "@/lib/auth/server";
import { serverEnv } from "@/shared/env/server";

type AgentTokenPayload = {
  sub: string;
  displayName: string | null;
  iat: number;
  exp: number;
};

const TOKEN_PREFIX = "cogni_ag_sk_v1_";
const AGENT_KEY_TTL_SECONDS = 60 * 60 * 24 * 30;

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  // Avoid regex backtracking: use startsWith + slice (O(n), no ReDoS risk).
  // Flagged by SonarQube on /^Bearer\s+(.+)$/i — the (.+) group allowed
  // super-linear backtracking on crafted Authorization headers.
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trimStart();
  return token || null;
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", serverEnv().AUTH_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

function parseAgentToken(token: string): AgentTokenPayload | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const encoded = token.slice(TOKEN_PREFIX.length);
  const [payloadB64, signature] = encoded.split(".");
  if (!payloadB64 || !signature) return null;
  const expected = signPayload(payloadB64);
  if (!safeCompare(signature, expected)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as AgentTokenPayload;
    if (!parsed.sub) return null;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function issueAgentApiKey(input: {
  userId: string;
  displayName: string | null;
}): string {
  const payload: AgentTokenPayload = {
    sub: input.userId,
    displayName: input.displayName,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + AGENT_KEY_TTL_SECONDS,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  return `${TOKEN_PREFIX}${payloadB64}.${signPayload(payloadB64)}`;
}

/**
 * Returns the agent API key's expiry (unix seconds) for the current request,
 * or null when the caller is not authenticated by an agent key (e.g. a cookie
 * session). Verifies the token signature (reuses parseAgentToken), so callers
 * get an authentic expiry, not an unverified claim. Used by `GET /api/v1/agent/me`
 * to surface key liveness without re-decoding the bearer by hand.
 */
export async function peekAgentKeyExpiry(): Promise<number | null> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return null;
  }
  const bearer = extractBearerToken(h.get("authorization"));
  if (!bearer) return null;
  if (isRevocableKey(bearer)) {
    // v2 expiry is a store fact, not a token claim. A broken store yields null (the /me route stays readable).
    try {
      const [{ getAgentCredentialStore }, { hashAgentKey }] = await Promise.all(
        [
          import("@/bootstrap/agent-credentials"),
          import("@cogni-dao/agent-grants/credentials"),
        ]
      );
      const row = await getAgentCredentialStore().lookup(
        await hashAgentKey(bearer)
      );
      return row && (row.state === "active" || row.state === "renew_only")
        ? Math.floor(new Date(row.expiresAt).getTime() / 1000)
        : null;
    } catch {
      return null;
    }
  }
  const payload = parseAgentToken(bearer);
  return payload?.exp ?? null;
}

/**
 * Verify a revocable key against the credential store, accepting the listed states. Used by the credential routes (rotate, confirm, revoke) that
 * take a pending or renew_only key. The store is loaded lazily: the v1 and session paths never touch it.
 */
export async function verifyRevocableKey(
  token: string,
  allow: readonly CredentialState[]
): Promise<VerifyResult> {
  const { getAgentCredentialStore, verifyAgentCredential } = await import(
    "@/bootstrap/agent-credentials"
  );
  const h = await headers();
  return verifyAgentCredential(getAgentCredentialStore(), token, allow, h);
}

/** The bearer token of the current request, if any (the credential routes read it to tell a signed key from a revocable one). */
export async function currentBearerToken(): Promise<string | null> {
  try {
    return extractBearerToken((await headers()).get("authorization"));
  } catch {
    return null;
  }
}

function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function resolveRequestIdentity(): Promise<SessionUser | null> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return getServerSessionUser();
  }
  const bearer = extractBearerToken(h.get("authorization"));
  if (bearer) {
    if (isRevocableKey(bearer)) {
      const verified = await verifyRevocableKey(bearer, ["active"]);
      if (verified.ok) {
        return {
          id: verified.userId,
          walletAddress: null,
          displayName: verified.name,
          avatarColor: null,
        };
      }
      if (verified.reason === "unavailable")
        throw new CredentialStoreUnavailableError(verified.cause);
      if (verified.reason === "rate_limited")
        throw new CredentialRateLimitedError();
      return null;
    }
    const payload = parseAgentToken(bearer);
    if (!payload) return null;
    const { getAgentCredentialStore } = await import(
      "@/bootstrap/agent-credentials"
    );
    await assertV1NotSuperseded(getAgentCredentialStore(), payload.sub);
    return {
      id: payload.sub,
      walletAddress: null,
      displayName: payload.displayName,
      avatarColor: null,
    };
  }

  if (!isSameOrigin(h.get("origin"), h.get("host"))) {
    return null;
  }

  return getServerSessionUser();
}
