// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { agentCredentialStatusOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { requestBearer } from "../../_shared";

export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.status", auth: { mode: "none" } },
  async (_ctx, request) => {
    const token = requestBearer(request);
    if (!token) {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    const result = await getContainer().agentIdentity.authenticate(
      token,
      "renew"
    );
    if (!result) {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    return NextResponse.json(
      agentCredentialStatusOperation.output.parse({
        actorId: result.principal.actorId,
        principalId: result.principal.principalId,
        credentialId: result.principal.credentialId,
        status: result.access,
        authenticateUntil: result.authenticateUntil,
        renewUntil: result.renewUntil,
      })
    );
  }
);
