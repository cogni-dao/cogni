// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { createAgentRecoveryGrantOperation } from "@cogni/node-contracts";
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
    routeId: "agent.recovery_grants.create",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    const rateLimited = agentIdentityRateLimitResponse(
      ctx,
      startedAt,
      "recovery_grant",
      request
    );
    if (rateLimited) return rateLimited;
    if (!isSameOriginMutation(request)) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "recovery_grant",
        { error: "csrf_denied" },
        { status: 403 }
      );
    }
    const body = await requestJson(request);
    const parsed = createAgentRecoveryGrantOperation.input.safeParse(
      body.ok ? body.value : undefined
    );
    if (!parsed.success) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "recovery_grant",
        { error: "Invalid request" },
        { status: 400 }
      );
    }
    try {
      const result = await getContainer().agentIdentity.createRecoveryGrant({
        issuerUserId: sessionUser.id,
        actorId: parsed.data.actorId,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return agentIdentityResponse(
        ctx,
        startedAt,
        "recovery_grant",
        createAgentRecoveryGrantOperation.output.parse({
          grantId: result.grantId,
          recoveryToken: result.token,
          expiresAt: result.expiresAt,
        }),
        { status: 201 }
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "recovery_grant",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
