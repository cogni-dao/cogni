// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/suspend`
 * Purpose: Suspend a stewarded AI and release its active-agent capacity slot.
 * Scope: Human same-origin lifecycle mutation only; never deletes identity or contribution history.
 * Invariants: CURRENT_STEWARD_ONLY; CREDENTIALS_REVOKED; HISTORY_PRESERVED.
 * Side-effects: Identity database reads/writes and structured terminal logging.
 * Links: story.5075, agent.actors.suspend.v1
 * @public
 */

import { suspendAgentOperation } from "@cogni/node-contracts";
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
    routeId: "agent.actors.suspend",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    const rateLimited = agentIdentityRateLimitResponse(
      ctx,
      startedAt,
      "suspend",
      request
    );
    if (rateLimited) return rateLimited;
    if (!isSameOriginMutation(request)) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "suspend",
        { error: "csrf_denied" },
        { status: 403 }
      );
    }
    const body = await requestJson(request);
    const parsed = suspendAgentOperation.input.safeParse(
      body.ok ? body.value : undefined
    );
    if (!parsed.success) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "suspend",
        { error: "invalid_request" },
        { status: 400 }
      );
    }
    try {
      const result = await getContainer().agentIdentity.suspendAgent({
        stewardUserId: sessionUser.id,
        actorId: parsed.data.actorId,
        reason: parsed.data.reason,
      });
      return agentIdentityResponse(
        ctx,
        startedAt,
        "suspend",
        suspendAgentOperation.output.parse(result)
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "suspend",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
