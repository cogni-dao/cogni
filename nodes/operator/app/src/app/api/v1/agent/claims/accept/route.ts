// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/claims/accept`
 * Purpose: Let the exact durable AI actor accept a pending human stewardship claim.
 * Scope: Authenticates a node-issued v2 bearer and accepts its own claim; never accepts for another actor.
 * Invariants: EXACT_AI_CALLER; NODE_ISSUED_CREDENTIAL; TWO_PARTY_CEREMONY.
 * Side-effects: Identity database reads/writes and structured terminal logging.
 * Links: story.5075, agent.existing-claims.accept.v1
 * @public
 */

import { acceptExistingAgentClaimOperation } from "@cogni/node-contracts";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  agentIdentityErrorResponse,
  agentIdentityRateLimitResponse,
  agentIdentityResponse,
  requestBearer,
  requestJson,
} from "../../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.existing_claims.accept", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const rateLimited = agentIdentityRateLimitResponse(
      ctx,
      startedAt,
      "claim_accept",
      request
    );
    if (rateLimited) return rateLimited;
    const token = requestBearer(request);
    const body = await requestJson(request);
    const parsed = acceptExistingAgentClaimOperation.input.safeParse(
      body.ok ? body.value : undefined
    );
    if (!token || !parsed.success) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "claim_accept",
        { error: "invalid_request" },
        { status: 400 }
      );
    }
    try {
      const credential = await getContainer().agentIdentity.authenticate(
        token,
        "data"
      );
      if (!credential) {
        return agentIdentityResponse(
          ctx,
          startedAt,
          "claim_accept",
          { error: "invalid_credential" },
          { status: 401 }
        );
      }
      const result =
        await getContainer().agentIdentity.acceptExistingAgentClaim({
          actorId: credential.principal.actorId,
          claimId: parsed.data.claimId,
        });
      return agentIdentityResponse(
        ctx,
        startedAt,
        "claim_accept",
        acceptExistingAgentClaimOperation.output.parse(result)
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "claim_accept",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
