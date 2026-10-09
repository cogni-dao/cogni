// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { createAgentRecoveryGrantOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";
import {
  agentIdentityErrorResponse,
  isSameOriginMutation,
} from "../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.recovery_grants.create",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    if (!isSameOriginMutation(request)) {
      return NextResponse.json({ error: "csrf_denied" }, { status: 403 });
    }
    const parsed = createAgentRecoveryGrantOperation.input.safeParse(
      await request.json()
    );
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    try {
      const result = await getContainer().agentIdentity.createRecoveryGrant({
        issuerUserId: sessionUser.id,
        actorId: parsed.data.actorId,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return NextResponse.json(
        createAgentRecoveryGrantOperation.output.parse({
          grantId: result.grantId,
          recoveryToken: result.token,
          expiresAt: result.expiresAt,
        }),
        { status: 201 }
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
);
