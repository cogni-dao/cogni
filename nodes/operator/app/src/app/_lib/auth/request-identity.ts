// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/request-identity`
 * Purpose: Unified request identity resolver — returns a SessionUser for
 *   either a valid HMAC-signed machine bearer token (`cogni_ag_sk_v1_...`)
 *   or a browser session cookie. One entry point for both auth surfaces.
 * Scope: Bearer parser + HMAC signer/verifier (issueAgentApiKey exported to
 *   the register route only), and resolveRequestIdentity which
 *   wrapRouteHandlerWithLogging consumes via `auth.getSessionUser`. Does NOT
 *   read from the database — all session IO happens via getServerSessionUser.
 *   Also exports resolveRequestIdentityResult / describeMissingIdentity /
 *   toWwwAuthenticateHeader so the wrapper can emit an RFC 6750 §3
 *   `WWW-Authenticate` challenge that distinguishes an expired/invalid bearer
 *   (401 `invalid_token`) from a missing credential (bare `Bearer` challenge).
 * Invariants:
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

/**
 * Why a token was rejected. `expired` and the other malformed/forged cases are
 * kept distinct so callers can surface a truthful `error_description` per
 * RFC 6750 §3 without leaking signature internals (all map to the RFC's single
 * `invalid_token` error code).
 */
export type TokenRejectReason =
  | "expired"
  | "malformed"
  | "bad_signature"
  | "not_agent_token";

type ParseAgentTokenResult =
  | { ok: true; payload: AgentTokenPayload }
  | { ok: false; reason: TokenRejectReason };

/**
 * RFC 6750 §3 `WWW-Authenticate: Bearer` challenge describing why identity
 * resolution failed for a request. `error === undefined` means no credential
 * was presented (missing-credential challenge — no `error` param per §3);
 * `error === "invalid_token"` means a bearer was presented but rejected.
 */
export type AuthChallenge = {
  scheme: "Bearer";
  error?: "invalid_token";
  errorDescription?: string;
};

/** Discriminated identity-resolution result carrying the reject reason. */
export type RequestIdentityResult =
  | { user: SessionUser }
  | { user: null; challenge: AuthChallenge };

const REJECT_DESCRIPTIONS: Record<TokenRejectReason, string> = {
  // Wording mirrors the RFC 6750 §3 example so agents can string-match expiry.
  expired: "The access token expired",
  malformed: "The access token is malformed",
  bad_signature: "The access token signature is invalid",
  not_agent_token: "The access token is invalid",
};

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

function parseAgentToken(token: string): ParseAgentTokenResult {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, reason: "not_agent_token" };
  }
  const encoded = token.slice(TOKEN_PREFIX.length);
  const [payloadB64, signature] = encoded.split(".");
  if (!payloadB64 || !signature) return { ok: false, reason: "malformed" };
  const expected = signPayload(payloadB64);
  if (!safeCompare(signature, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as AgentTokenPayload;
    if (!parsed.sub) return { ok: false, reason: "malformed" };
    // Expiry is a distinct, non-secret reason — surfaced so a caller can tell
    // an expired token apart from a forged/malformed one (RFC 6750 §3).
    if (parsed.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, payload: parsed };
  } catch {
    return { ok: false, reason: "malformed" };
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

function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Resolve request identity, carrying the reject reason when resolution fails.
 * This is the richer form used to build an RFC 6750 §3 challenge; most callers
 * want the thin `resolveRequestIdentity` (SessionUser | null) instead.
 */
export async function resolveRequestIdentityResult(): Promise<RequestIdentityResult> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    const user = await getServerSessionUser();
    return user ? { user } : { user: null, challenge: { scheme: "Bearer" } };
  }
  const bearer = extractBearerToken(h.get("authorization"));
  if (bearer) {
    const result = parseAgentToken(bearer);
    // BEARER_CLAIMS_EXCLUSIVE: a presented-but-invalid bearer NEVER falls back
    // to session cookies — return an invalid_token challenge instead.
    if (!result.ok) {
      return {
        user: null,
        challenge: {
          scheme: "Bearer",
          error: "invalid_token",
          errorDescription: REJECT_DESCRIPTIONS[result.reason],
        },
      };
    }
    return {
      user: {
        id: result.payload.sub,
        walletAddress: null,
        displayName: result.payload.displayName,
        avatarColor: null,
      },
    };
  }

  if (!isSameOrigin(h.get("origin"), h.get("host"))) {
    return { user: null, challenge: { scheme: "Bearer" } };
  }

  const user = await getServerSessionUser();
  return user ? { user } : { user: null, challenge: { scheme: "Bearer" } };
}

export async function resolveRequestIdentity(): Promise<SessionUser | null> {
  const result = await resolveRequestIdentityResult();
  return result.user;
}

/**
 * Header-only challenge builder for the route wrapper. When a required route
 * has already resolved a null identity, this inspects the Authorization header
 * (WITHOUT touching the session store) to decide whether to emit a
 * `invalid_token` challenge (bearer present but bad) or a bare missing-credential
 * `Bearer` challenge (no/other credential). Cheap: no session IO, no DB.
 */
export async function describeMissingIdentity(): Promise<AuthChallenge> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return { scheme: "Bearer" };
  }
  const bearer = extractBearerToken(h.get("authorization"));
  if (!bearer) return { scheme: "Bearer" };
  const result = parseAgentToken(bearer);
  if (result.ok) {
    // A valid bearer that still yielded a null identity is not a token problem
    // (e.g. same-origin/session path). Fall back to the bare challenge.
    return { scheme: "Bearer" };
  }
  return {
    scheme: "Bearer",
    error: "invalid_token",
    errorDescription: REJECT_DESCRIPTIONS[result.reason],
  };
}

/**
 * Serialize an {@link AuthChallenge} into an RFC 6750 §3 `WWW-Authenticate`
 * header value. Missing-credential → `Bearer`; invalid → `Bearer
 * error="invalid_token", error_description="..."`.
 */
export function toWwwAuthenticateHeader(challenge: AuthChallenge): string {
  const params: string[] = [];
  if (challenge.error) params.push(`error="${challenge.error}"`);
  if (challenge.errorDescription) {
    // Descriptions here are fixed, quote-free constants; no escaping needed.
    params.push(`error_description="${challenge.errorDescription}"`);
  }
  return params.length ? `Bearer ${params.join(", ")}` : "Bearer";
}
