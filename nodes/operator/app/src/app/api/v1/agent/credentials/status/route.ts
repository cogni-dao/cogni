// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { agentCredentialStatusOperation } from "@cogni/node-contracts";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  agentIdentityRateLimitResponse,
  agentIdentityResponse,
  logAgentIdentityUnexpectedError,
  requestBearer,
} from "../../_shared";

export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.status", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const rateLimited = agentIdentityRateLimitResponse(
      ctx,
      startedAt,
      "status",
      request
    );
    if (rateLimited) return rateLimited;
    const token = requestBearer(request);
    if (!token) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "status",
        { error: "invalid_token" },
        { status: 401 }
      );
    }
    try {
      const result = await getContainer().agentIdentity.authenticate(
        token,
        "renew"
      );
      if (!result) {
        return agentIdentityResponse(
          ctx,
          startedAt,
          "status",
          { error: "invalid_token" },
          { status: 401 }
        );
      }
      return agentIdentityResponse(
        ctx,
        startedAt,
        "status",
        agentCredentialStatusOperation.output.parse({
          actorId: result.principal.actorId,
          principalId: result.principal.principalId,
          credentialId: result.principal.credentialId,
          status: result.access,
          authenticateUntil: result.authenticateUntil,
          renewUntil: result.renewUntil,
        })
      );
    } catch (error) {
      logAgentIdentityUnexpectedError(ctx, startedAt, "status");
      throw error;
    }
  }
);
