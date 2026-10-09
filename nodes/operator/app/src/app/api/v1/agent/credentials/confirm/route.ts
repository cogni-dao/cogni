// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { confirmAgentCredentialOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { agentIdentityErrorResponse, requestBearer } from "../../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.confirm", auth: { mode: "none" } },
  async (_ctx, request) => {
    const token = requestBearer(request);
    if (!token) {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    try {
      const result = await getContainer().agentIdentity.confirm(token);
      return NextResponse.json(
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
      const response = agentIdentityErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
);
