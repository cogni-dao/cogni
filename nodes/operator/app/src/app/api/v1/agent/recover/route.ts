// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { recoverAgentCredentialOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { agentIdentityErrorResponse } from "../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.recover", auth: { mode: "none" } },
  async (_ctx, request) => {
    const parsed = recoverAgentCredentialOperation.input.safeParse(
      await request.json()
    );
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    try {
      const result = await getContainer().agentIdentity.recover(
        parsed.data.recoveryToken
      );
      return NextResponse.json(
        recoverAgentCredentialOperation.output.parse(result),
        { status: 201 }
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
);
