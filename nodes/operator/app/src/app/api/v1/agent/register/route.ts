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
 *   been issued yet. Security hardening (invitation token) tracked in bug.0297.
 * Links: docs/spec/security-auth.md, bug.0297
 * @public
 */

import { registerAgentV2Operation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { agentIdentityErrorResponse } from "../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.register", auth: { mode: "none" } },
  async (_ctx, request) => {
    const parsed = registerAgentV2Operation.input.safeParse(
      await request.json()
    );
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    try {
      const result = await getContainer().agentIdentity.redeemSpawnGrant(
        parsed.data.spawnToken
      );
      return NextResponse.json(registerAgentV2Operation.output.parse(result), {
        status: 201,
      });
    } catch (error) {
      const response = agentIdentityErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
);
