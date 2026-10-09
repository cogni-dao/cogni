// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { rotateAgentCredentialOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { agentIdentityErrorResponse, requestBearer } from "../../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.rotate", auth: { mode: "none" } },
  async (_ctx, request) => {
    const token = requestBearer(request);
    const parsed = rotateAgentCredentialOperation.input.safeParse(
      await request.json()
    );
    if (!token || !parsed.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    try {
      const result = await getContainer().agentIdentity.rotate({
        token,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return NextResponse.json(
        rotateAgentCredentialOperation.output.parse(result)
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
);
