// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/register`
 * Purpose: Redeem a one-use spawn grant into one durable agent actor and its first credential.
 * Scope: Instrumented via wrapRouteHandlerWithLogging so every attempt hits
 *   the structured log envelope (request received / request complete) and
 *   the http_requests_total / http_request_duration_ms metrics like every
 *   other /api/v1/* route. auth.mode=none because the endpoint is the
 *   onboarding seam itself — callers can't present credentials they haven't
 *   been issued yet. The one-use, expiring spawn grant is the onboarding
 *   authority; anonymous self-registration is not supported.
 * Links: docs/spec/security-auth.md, https://cognidao.org/knowledge/human-ai-identity-standard
 * @public
 */

import { registerAgentV2Operation } from "@cogni/node-contracts";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  agentIdentityErrorResponse,
  agentIdentityRateLimitResponse,
  agentIdentityResponse,
  requestJson,
} from "../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.register", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const rateLimited = agentIdentityRateLimitResponse(
      ctx,
      startedAt,
      "register",
      request
    );
    if (rateLimited) return rateLimited;
    const body = await requestJson(request);
    const parsed = registerAgentV2Operation.input.safeParse(
      body.ok ? body.value : undefined
    );
    if (!parsed.success) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "register",
        { error: "Invalid request" },
        { status: 400 }
      );
    }
    try {
      const result = await getContainer().agentIdentity.redeemSpawnGrant(
        parsed.data.spawnToken
      );
      return agentIdentityResponse(
        ctx,
        startedAt,
        "register",
        registerAgentV2Operation.output.parse(result),
        { status: 201 }
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "register",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
