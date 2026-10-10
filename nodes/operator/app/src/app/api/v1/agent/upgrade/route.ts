// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { upgradeLegacyAgentCredentialOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { verifyLegacyAgentApiKey } from "@/app/_lib/auth/request-identity";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { agentIdentityErrorResponse, requestBearer } from "../_shared";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.legacy_upgrade", auth: { mode: "none" } },
  async (_ctx, request) => {
    const token = requestBearer(request);
    const legacy = token ? verifyLegacyAgentApiKey(token) : null;
    const parsed = upgradeLegacyAgentCredentialOperation.input.safeParse(
      await request.json()
    );
    if (!token || !legacy || !parsed.success) {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    try {
      const result = await getContainer().agentIdentity.upgradeLegacy({
        legacyToken: token,
        legacyUserId: legacy.sub,
        displayName: legacy.displayName,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return NextResponse.json(
        upgradeLegacyAgentCredentialOperation.output.parse(result),
        { status: 201 }
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
);
