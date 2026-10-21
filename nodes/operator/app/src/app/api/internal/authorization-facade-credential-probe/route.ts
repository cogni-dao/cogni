// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Credential-only probe for rotation proof. It exposes no authorization data. */

import { NextResponse } from "next/server";

import { authenticateAuthorizationFacadeRequest } from "@/app/_lib/authorization-facade-auth";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";
import { createRouteTerminalLogger } from "@/shared/observability/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "authorization.facade.credential_probe",
    auth: { mode: "none" },
  },
  async (ctx, request) => {
    const startedAt = performance.now();
    const terminal = createRouteTerminalLogger(
      ctx,
      EVENT_NAMES.AUTHORIZATION_FACADE_CREDENTIAL_PROBE_COMPLETE,
      startedAt
    );
    try {
      const auth = await authenticateAuthorizationFacadeRequest(request);
      const status = auth.ok ? 204 : auth.status;
      terminal.complete({
        status,
        outcome: auth.ok ? "success" : "error",
        ...(!auth.ok
          ? { errorCode: auth.errorCode, reasonCode: auth.errorCode }
          : {}),
      });
      if (!auth.ok) {
        return NextResponse.json(
          { error: auth.errorCode },
          { status: auth.status, headers: { "Cache-Control": "no-store" } }
        );
      }
      return new NextResponse(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      terminal.internalError();
      throw error;
    }
  }
);
