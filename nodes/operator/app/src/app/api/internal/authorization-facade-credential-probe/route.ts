// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Credential-only probe for rotation proof. It exposes no authorization data. */

import { NextResponse } from "next/server";

import { authenticateAuthorizationFacadeRequest } from "@/app/_lib/authorization-facade-auth";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "authorization.facade.credential_probe",
    auth: { mode: "none" },
  },
  async (ctx, request) => {
    const startedAt = performance.now();
    const auth = await authenticateAuthorizationFacadeRequest(request);
    const status = auth.ok ? 204 : auth.status;
    logEvent(
      ctx.log,
      EVENT_NAMES.AUTHORIZATION_FACADE_CREDENTIAL_PROBE_COMPLETE,
      {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: auth.ok ? "success" : "error",
        ...(!auth.ok ? { errorCode: auth.errorCode } : {}),
      }
    );
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
  }
);
