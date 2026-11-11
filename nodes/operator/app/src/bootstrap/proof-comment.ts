// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/proof-comment`
 * Purpose: Composition for the `github.comment.attestation.v1` route (task.0095): the operator's own GitHub App reader, the registry and
 *   signer ports, and the three in-memory limits (client, per node, route-wide).
 * Scope: Wiring and limiter instances only. The policy lives in `features/identity/services/read-proof-comment`.
 * Invariants:
 *   - GITHUB_CALL_BUDGET: the App's 5000 per hour is shared with every flight and merge. The route spends at most 300 GitHub calls per hour
 *     (12 percent), at most 100 for one node. A cache hit spends none. In memory per instance, so with N replicas the real cap is N times that.
 *   - CLIENT_BUCKET_FIRST: the per-client bucket runs in `wrapPublicRoute`, keyed on `cf-connecting-ip`, before any other bucket or GitHub read.
 * Side-effects: global (limiter maps, per-instance)
 * Links: https://cognidao.org/work/items/task.0095
 * @public
 */

import type { KeyObject } from "node:crypto";
import { randomUUID } from "node:crypto";
import { GithubAppProofCommentReader } from "@/adapters/server";
import { TokenBucketRateLimiter } from "@/bootstrap/http/rateLimiter";
import { resolveIdentityAttestationDependencies } from "@/bootstrap/identity-attestation";
import { serverEnv } from "@/shared/env/server-env";

/** Per client (`cf-connecting-ip`): 60 per hour, burst 10. A flood from one address stops here and spends nothing of the shared budgets. */
export const proofCommentClientLimiter = new TokenBucketRateLimiter({
  maxTokens: 10,
  refillRate: 60 / 3600,
  burstSize: 0,
  maxKeys: 10_000,
});

const nodeCallLimiter = new TokenBucketRateLimiter({
  maxTokens: 100,
  refillRate: 100 / 3600,
  burstSize: 0,
  maxKeys: 1_000,
});
const routeCallLimiter = new TokenBucketRateLimiter({
  maxTokens: 300,
  refillRate: 300 / 3600,
  burstSize: 0,
});

/** Spend one GitHub call for the node and for the route; nothing is spent when either is over its cap. */
export const proofCommentCallBudget = {
  take(nodeId: string): boolean {
    if (
      !nodeCallLimiter.hasTokens(nodeId) ||
      !routeCallLimiter.hasTokens("route")
    )
      return false;
    nodeCallLimiter.consume(nodeId);
    routeCallLimiter.consume("route");
    return true;
  },
};

export type ProofCommentConfigErrorCode =
  | "github_unavailable"
  | "signing_unavailable";

export class ProofCommentConfigError extends Error {
  constructor(readonly code: ProofCommentConfigErrorCode) {
    super(code);
    this.name = "ProofCommentConfigError";
  }
}

export function resolveProofCommentDependencies(params: {
  signingKey: KeyObject;
  issuer: string;
}) {
  const env = serverEnv();
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64)
    throw new ProofCommentConfigError("github_unavailable");
  if (!env.NODE_SUBMODULE_PARENT_OWNER)
    throw new ProofCommentConfigError("github_unavailable");
  const base = resolveIdentityAttestationDependencies(params.signingKey);
  return {
    repository: base.repository,
    signer: base.signer,
    clock: base.clock,
    createJti: randomUUID,
    issuer: params.issuer,
    parentOwner: env.NODE_SUBMODULE_PARENT_OWNER,
    budget: proofCommentCallBudget,
    reader: new GithubAppProofCommentReader({
      appId: env.GH_REVIEW_APP_ID,
      privateKey: Buffer.from(
        env.GH_REVIEW_APP_PRIVATE_KEY_BASE64,
        "base64"
      ).toString("utf-8"),
    }),
  };
}
