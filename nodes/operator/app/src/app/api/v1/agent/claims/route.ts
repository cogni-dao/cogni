// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/claims`
 * Purpose: Let a signed-in human propose stewardship of an existing AI actor.
 * Scope: Verifies target-bound provider evidence and creates a pending claim; never mutates stewardship before AI acceptance.
 * Invariants: HUMAN_PROPOSES; AI_ACCEPTS; TARGET_BOUND_ATTESTATION; SAME_ORIGIN.
 * Side-effects: Identity database reads/writes and structured terminal logging.
 * Links: story.5075, agent.existing-claims.create.v1
 * @public
 */

import { createExistingAgentClaimOperation } from "@cogni/node-contracts";
import { verifyAgentClaimAttestation } from "@/bootstrap/agent-claim-attestation";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";
import {
  agentIdentityErrorResponse,
  agentIdentityRateLimitResponse,
  agentIdentityResponse,
  isSameOriginMutation,
  requestJson,
} from "../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.existing_claims.create",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    const rateLimited = agentIdentityRateLimitResponse(
      ctx,
      startedAt,
      "claim_create",
      request
    );
    if (rateLimited) return rateLimited;
    if (!isSameOriginMutation(request)) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "claim_create",
        { error: "csrf_denied" },
        { status: 403 }
      );
    }
    const body = await requestJson(request);
    const parsed = createExistingAgentClaimOperation.input.safeParse(
      body.ok ? body.value : undefined
    );
    if (!parsed.success) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "claim_create",
        { error: "invalid_request" },
        { status: 400 }
      );
    }
    try {
      const claims = await verifyAgentClaimAttestation(
        parsed.data.identityAttestation
      );
      const result = await getContainer().agentIdentity.createExistingAgentClaim({
        stewardUserId: sessionUser.id,
        actorId: parsed.data.actorId,
        provider: "github",
        externalId: claims.github.id,
        providerLogin: claims.github.login,
        attestationJti: claims.jti,
        attestationEvidence: {
          issuer: claims.iss,
          audience: claims.aud,
          nodeId: claims.nodeId,
          nonce: claims.nonce,
          targetOrigin: claims.targetOrigin,
          issuedAt: claims.iat,
        },
        attestationExpiresAt: new Date(claims.exp * 1000),
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return agentIdentityResponse(
        ctx,
        startedAt,
        "claim_create",
        createExistingAgentClaimOperation.output.parse(result),
        { status: 201 }
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "claim_create",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
