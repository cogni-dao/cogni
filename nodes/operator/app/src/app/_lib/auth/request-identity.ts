// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/request-identity`
 * Purpose: Resolve browser sessions and node-local DB-backed agent bearers.
 * Scope: v2 agent credentials resolve to RequestPrincipal; the SessionUser
 *   export remains a compatibility adapter for routes not yet principal-aware.
 *   Legacy v1 HMAC verification stays available only for additive upgrade and
 *   the measured compatibility window.
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
 * Links: docs/spec/security-auth.md, https://cognidao.org/knowledge/human-ai-identity-standard
 * @public
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestPrincipal } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { headers } from "next/headers";
import { getServerSessionUser } from "@/lib/auth/server";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server";

type AgentTokenPayload = {
  sub: string;
  displayName: string | null;
  iat: number;
  exp: number;
};

const LEGACY_TOKEN_PREFIX = "cogni_ag_sk_v1_";
const STATEFUL_TOKEN_PREFIX = "cogni_ag_sk_v2_";
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

export function extractBearerToken(authHeader: string | null): string | null {
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

export function verifyLegacyAgentApiKey(
  token: string
): AgentTokenPayload | null {
  if (!token.startsWith(LEGACY_TOKEN_PREFIX)) return null;
  const encoded = token.slice(LEGACY_TOKEN_PREFIX.length);
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
  return `${LEGACY_TOKEN_PREFIX}${payloadB64}.${signPayload(payloadB64)}`;
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
  const payload = verifyLegacyAgentApiKey(bearer);
  return payload?.exp ?? null;
}

export class RequestIdentityUnavailableError extends Error {
  constructor(message = "Agent credential store unavailable") {
    super(message);
    this.name = "RequestIdentityUnavailableError";
  }
}

/**
 * Project a verified request principal into the legacy SessionUser shape only
 * when the credential belongs to a human. Agent-to-user compatibility links
 * never confer human governance authority.
 */
export function humanSessionUserFromPrincipal(
  principal: RequestPrincipal | null
): SessionUser | null {
  if (principal?.kind !== "human") return null;
  return {
    id: principal.userId,
    walletAddress: principal.walletAddress,
    displayName: principal.displayName,
    avatarColor: principal.avatarColor,
  };
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
    if (bearer.startsWith(STATEFUL_TOKEN_PREFIX)) {
      try {
        const { getContainer } = await import("@/bootstrap/container");
        const status = await getContainer().agentIdentity.authenticate(
          bearer,
          "data"
        );
        if (!status || !status.principal.legacyUserId) return null;
        return {
          // Compatibility projection for upgraded v1 callers only. A freshly
          // spawned durable agent has no user link and can never enter a
          // SessionUser route. Principal-aware routes must use
          // resolveRequestPrincipal() and the exact agent principal.
          id: status.principal.legacyUserId,
          walletAddress: null,
          displayName: status.principal.displayName,
          avatarColor: null,
        };
      } catch {
        // Credential-store failures fail closed. No AUTH_SECRET fallback.
        return null;
      }
    }
    const payload = verifyLegacyAgentApiKey(bearer);
    if (!payload) return null;
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

/** Resolve the non-counterfeit request principal for principal-aware routes. */
export async function resolveRequestPrincipal(): Promise<RequestPrincipal | null> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    const session = await getServerSessionUser();
    return session
      ? {
          kind: "human",
          principalId: `user:${getNodeId()}/${session.id}`,
          userId: session.id,
          walletAddress: session.walletAddress,
          displayName: session.displayName,
          avatarColor: session.avatarColor,
        }
      : null;
  }
  const bearer = extractBearerToken(h.get("authorization"));
  if (bearer) {
    if (bearer.startsWith(STATEFUL_TOKEN_PREFIX)) {
      try {
        const { getContainer } = await import("@/bootstrap/container");
        return (
          (await getContainer().agentIdentity.authenticate(bearer, "data"))
            ?.principal ?? null
        );
      } catch (error) {
        throw new RequestIdentityUnavailableError(
          error instanceof Error ? error.message : undefined
        );
      }
    }
    const legacy = verifyLegacyAgentApiKey(bearer);
    return legacy
      ? {
          kind: "legacy_agent",
          principalId: `user:${getNodeId()}/${legacy.sub}`,
          legacyUserId: legacy.sub,
          displayName: legacy.displayName,
          expiresAt: new Date(legacy.exp * 1000).toISOString(),
        }
      : null;
  }
  if (!isSameOrigin(h.get("origin"), h.get("host"))) return null;
  const session = await getServerSessionUser();
  return session
    ? {
        kind: "human",
        principalId: `user:${getNodeId()}/${session.id}`,
        userId: session.id,
        walletAddress: session.walletAddress,
        displayName: session.displayName,
        avatarColor: session.avatarColor,
      }
    : null;
}

/** Resolve a human session without accepting either legacy or durable agents. */
export async function resolveHumanRequestIdentity(): Promise<SessionUser | null> {
  try {
    return humanSessionUserFromPrincipal(await resolveRequestPrincipal());
  } catch (error) {
    // Preserve the required-auth resolver contract: credential-store failure is
    // a rejected bearer and can never fall through to a cookie or governance.
    if (error instanceof RequestIdentityUnavailableError) return null;
    throw error;
  }
}
