// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/identity/proof-comment`
 * Purpose: Public. A node asks the operator to read ONE proof comment of its own repository and sign the facts (`github.comment.attestation.v1`,
 *   task.0095). The node checks the signature and decides; the operator decides nothing. No node holds a GitHub credential.
 * Scope: Public route (`wrapPublicRoute`): strict body parse, delegation to the proof-comment facade, one terminal event, status mapping.
 *   Public because the node has no operator credential and the answer is public GitHub data bound to one node (`aud`, echoed `requestNonce`).
 * Invariants:
 *   - STRICT_REQUEST: `{ nodeId, requestNonce, issue, commentId }` and nothing else. A `challengeSecret` field is a 400: the operator can never learn it.
 *   - CLIENT_BUCKET_FIRST: the route's own limiter keyed on `cf-connecting-ip` runs in the wrapper before any cache, bucket or GitHub read.
 *   - NEVER_CACHED: the answer is `no-store` (`wrapPublicRoute` leaves an existing Cache-Control alone).
 *   - TERMINAL_EVENT: exactly one of `identity.proof_comment.issued` or `identity.proof_comment.refused`, plus `identity.proof_comment.github_failed`
 *     when GitHub fails. Never a body, login, nonce, token, header or secret. `callerReqId` is the node's `x-request-id`.
 * Side-effects: IO (registry read, GitHub read through the facade)
 * Links: https://cognidao.org/work/items/task.0095
 * @public
 */

import { GithubCommentAttestationRequestSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { issueProofCommentAttestation } from "@/app/_facades/identity/proof-comment.server";
import { wrapPublicRoute } from "@/bootstrap/http";
import { extractEdgeClientIp } from "@/bootstrap/http/rateLimiter";
import { proofCommentClientLimiter } from "@/bootstrap/proof-comment";
import type { ProofCommentRefusal } from "@/features/identity/services/read-proof-comment";
import { EVENT_NAMES } from "@/shared/observability";

type ErrorCode = "invalid_request" | ProofCommentRefusal;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "identity.proof_comment";
const MAX_BODY_BYTES = 2048;
const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unknown_node: 404,
  repo_not_allowed: 400,
  rate_limited: 429,
  github_unavailable: 503,
  signing_unavailable: 503,
};

const NO_STORE = { "cache-control": "no-store" } as const;

function refusal(code: ErrorCode): NextResponse {
  return NextResponse.json(
    { error: code },
    {
      status: STATUS[code],
      headers: {
        ...NO_STORE,
        ...(code === "rate_limited" ? { "retry-after": "60" } : {}),
      },
    }
  );
}

export const POST = wrapPublicRoute(
  {
    routeId: ROUTE_ID,
    limiter: proofCommentClientLimiter,
    clientKey: extractEdgeClientIp,
  },
  async (ctx, request) => {
    const startedAt = Date.now();
    const callerReqId =
      request.headers.get("x-request-id")?.slice(0, 64) ?? null;
    const refuse = (code: ErrorCode, nodeId?: string): NextResponse => {
      ctx.log.info(
        {
          event: EVENT_NAMES.IDENTITY_PROOF_COMMENT_REFUSED,
          nodeId,
          errorCode: code,
          durationMs: Date.now() - startedAt,
          callerReqId,
        },
        EVENT_NAMES.IDENTITY_PROOF_COMMENT_REFUSED
      );
      return refusal(code);
    };

    // Strict shape. The body is read as text so an oversize one is refused before it is parsed.
    let raw: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return refuse("invalid_request");
      raw = JSON.parse(text);
    } catch {
      return refuse("invalid_request");
    }
    const parsed = GithubCommentAttestationRequestSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_request");
    const nodeId = parsed.data.nodeId;

    const outcome = await issueProofCommentAttestation(parsed.data, {
      githubFailed: (fields) =>
        ctx.log.warn(
          {
            event: EVENT_NAMES.IDENTITY_PROOF_COMMENT_GITHUB_FAILED,
            nodeId,
            dep: "github",
            ...fields,
          },
          EVENT_NAMES.IDENTITY_PROOF_COMMENT_GITHUB_FAILED
        ),
    });
    if (!outcome.ok) return refuse(outcome.code, nodeId);

    ctx.log.info(
      {
        event: EVENT_NAMES.IDENTITY_PROOF_COMMENT_ISSUED,
        nodeId,
        result: outcome.result,
        userType: outcome.userType,
        githubId: outcome.githubId,
        edited: outcome.edited,
        cache: outcome.cache,
        durationMs: Date.now() - startedAt,
        callerReqId,
      },
      EVENT_NAMES.IDENTITY_PROOF_COMMENT_ISSUED
    );
    return NextResponse.json(
      { attestation: outcome.attestation },
      { status: 200, headers: NO_STORE }
    );
  }
);
