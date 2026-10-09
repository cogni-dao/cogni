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
 * Links: docs/spec/security-auth.md, docs/spec/identity-model.md
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
        if (!status) return null;
        return {
          // Compatibility only. Principal-aware callers use
          // resolveRequestPrincipal() and receive the node-qualified
          // agent:{node_id}/{actor_id} shared-store subject directly. Keeping
          // legacyUserId here does not copy or migrate any OpenFGA tuple.
          id: status.principal.legacyUserId ?? status.principal.actorId,
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
    if (!bearer.startsWith(STATEFUL_TOKEN_PREFIX)) return null;
    try {
      const { getContainer } = await import("@/bootstrap/container");
      return (
        (await getContainer().agentIdentity.authenticate(bearer, "data"))
          ?.principal ?? null
      );
    } catch {
      return null;
    }
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
