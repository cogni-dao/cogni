// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { recoverAgentCredentialOperation } from "@cogni/node-contracts";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { agentIdentityErrorResponse, agentIdentityResponse } from "../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.recover", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const parsed = recoverAgentCredentialOperation.input.safeParse(
      await request.json()
    );
    if (!parsed.success) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "recover",
        { error: "Invalid request" },
        { status: 400 }
      );
    }
    try {
      const result = await getContainer().agentIdentity.recover(
        parsed.data.recoveryToken
      );
      return agentIdentityResponse(
        ctx,
        startedAt,
        "recover",
        recoverAgentCredentialOperation.output.parse(result),
        { status: 201 }
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "recover",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
