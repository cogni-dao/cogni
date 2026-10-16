// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { rotateAgentCredentialOperation } from "@cogni/node-contracts";
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
  { routeId: "agent.credentials.rotate", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const rateLimited = agentIdentityRateLimitResponse(
      ctx,
      startedAt,
      "rotate",
      request
    );
    if (rateLimited) return rateLimited;
    const token = requestBearer(request);
    const body = await requestJson(request);
    const parsed = rotateAgentCredentialOperation.input.safeParse(
      body.ok ? body.value : undefined
    );
    if (!token || !parsed.success) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "rotate",
        { error: "invalid_request" },
        { status: 400 }
      );
    }
    try {
      const result = await getContainer().agentIdentity.rotate({
        token,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return agentIdentityResponse(
        ctx,
        startedAt,
        "rotate",
        rotateAgentCredentialOperation.output.parse(result)
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "rotate",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
