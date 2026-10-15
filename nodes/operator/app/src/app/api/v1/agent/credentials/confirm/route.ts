// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { confirmAgentCredentialOperation } from "@cogni/node-contracts";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  agentIdentityErrorResponse,
  agentIdentityResponse,
  requestBearer,
} from "../../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.confirm", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const token = requestBearer(request);
    if (!token) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "confirm",
        { error: "invalid_token" },
        { status: 401 }
      );
    }
    try {
      const result = await getContainer().agentIdentity.confirm(token);
      return agentIdentityResponse(
        ctx,
        startedAt,
        "confirm",
        confirmAgentCredentialOperation.output.parse({
          actorId: result.principal.actorId,
          principalId: result.principal.principalId,
          credentialId: result.principal.credentialId,
          status: result.access,
          authenticateUntil: result.authenticateUntil,
          renewUntil: result.renewUntil,
        })
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "confirm",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
