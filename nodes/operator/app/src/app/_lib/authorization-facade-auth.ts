// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/authorization-facade-auth`
 * Purpose: Authenticate node workloads at the operator-mediated authorization facade.
 * Scope: Bearer parsing, server-derived node resolution, lane-local digest verification, and rate limiting.
 * Invariants: NODE_FROM_CREDENTIAL; EXACT_LANE_AND_NODE; NO_TOKEN_LOGGING; FAIL_CLOSED.
 * Side-effects: DB reads; in-memory rate-limit state.
 * Links: task.5226, src/app/api/v1/authorization
 * @internal
 */

import { authorizationFacadeCredentialFromToken } from "@cogni/authorization-core";

import { createAuthorizationFacadeCredentialVerifier } from "@/bootstrap/capabilities/authorization-facade-credential-verifier";
import { resolveServiceDb } from "@/bootstrap/container";
import { TokenBucketRateLimiter } from "@/bootstrap/http";
import {
  type ResolvedNodeRef,
  resolveNodeRef,
} from "@/features/nodes/node-lookup";
import { serverEnv } from "@/shared/env";

const globalCredentialAttemptLimiter = new TokenBucketRateLimiter({
  maxTokens: 240,
  refillRate: 4,
  burstSize: 40,
});

const nodeCandidateLimiter = new TokenBucketRateLimiter({
  maxTokens: 30,
  refillRate: 0.5,
  burstSize: 10,
});

const authenticatedNodeLimiter = new TokenBucketRateLimiter({
  maxTokens: 120,
  refillRate: 2,
  burstSize: 20,
});

export type AuthorizationFacadeAuthentication =
  | { readonly ok: true; readonly node: ResolvedNodeRef }
  | {
      readonly ok: false;
      readonly status: 401 | 429 | 503;
      readonly errorCode:
        | "invalid_service_credential"
        | "rate_limited"
        | "authorization_facade_unavailable";
    };

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length);
  return token.length > 0 && token.trim() === token ? token : undefined;
}

/**
 * The service credential proves only a node workload identity. P0 intentionally
 * lets that already-trusted node backend assert one of its local human IDs; each
 * mutation separately proves that exact human's current `can_grant`. A compromised
 * node can impersonate its own local users (it already controls their local DB and
 * account data), but the derived namespace prevents any cross-node authority.
 */
export async function authenticateAuthorizationFacadeRequest(
  request: Request
): Promise<AuthorizationFacadeAuthentication> {
  // Fixed global bucket is intentionally independent of caller-controlled proxy
  // headers. It bounds aggregate parsing work even when candidates are rotated.
  if (!globalCredentialAttemptLimiter.consume("authorization-facade")) {
    return { ok: false, status: 429, errorCode: "rate_limited" };
  }
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, status: 401, errorCode: "invalid_service_credential" };
  }

  let credential: ReturnType<typeof authorizationFacadeCredentialFromToken>;
  try {
    credential = authorizationFacadeCredentialFromToken(token);
  } catch {
    return { ok: false, status: 401, errorCode: "invalid_service_credential" };
  }

  // Node identity is embedded in the credential format, so this bucket executes
  // before any DB or OpenBao IO and cannot be evaded by spoofing forwarding headers.
  if (!nodeCandidateLimiter.consume(credential.nodeId)) {
    return { ok: false, status: 429, errorCode: "rate_limited" };
  }

  const env = serverEnv();
  const deployEnv = env.DEPLOY_ENVIRONMENT;
  if (!deployEnv) {
    return {
      ok: false,
      status: 503,
      errorCode: "authorization_facade_unavailable",
    };
  }

  try {
    const node = await resolveNodeRef(resolveServiceDb(), credential.nodeId);
    if (!node) {
      return {
        ok: false,
        status: 401,
        errorCode: "invalid_service_credential",
      };
    }
    const lane = credential.lane;
    if (!lane || lane !== deployEnv || !node.deployEnvs.includes(lane)) {
      return {
        ok: false,
        status: 401,
        errorCode: "invalid_service_credential",
      };
    }
    const verifier = createAuthorizationFacadeCredentialVerifier(env);
    const verification = await verifier.verify({
      lane,
      nodeId: node.nodeId,
      presentedCredential: token,
    });
    if (verification.decision === "unavailable") {
      return {
        ok: false,
        status: 503,
        errorCode: "authorization_facade_unavailable",
      };
    }
    if (verification.decision !== "valid") {
      return {
        ok: false,
        status: 401,
        errorCode: "invalid_service_credential",
      };
    }
    return authenticatedNodeLimiter.consume(credential.nodeId)
      ? { ok: true, node }
      : { ok: false, status: 429, errorCode: "rate_limited" };
  } catch {
    return {
      ok: false,
      status: 503,
      errorCode: "authorization_facade_unavailable",
    };
  }
}
