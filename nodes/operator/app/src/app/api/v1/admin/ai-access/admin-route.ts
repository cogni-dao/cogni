// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Admin identity and the node-admin gate precede every shared access operation. */
import {
  type AdminAiAccessCall,
  adminAiAccessHttp,
} from "@cogni-dao/agent-grants/http";
import { NextResponse } from "next/server";
import { currentBearerToken } from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAdminAiAccessCalls } from "@/bootstrap/agent-tool-authority";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env/server";
import { deps, send } from "./respond";

function hasCanonicalOrigin(origin: string | null): boolean {
  try {
    const base = serverEnv().APP_BASE_URL;
    if (!base || !origin) return false;
    const expected = new URL(base);
    const actual = new URL(origin);
    return (
      (expected.protocol === "https:" || expected.protocol === "http:") &&
      !expected.username &&
      !expected.password &&
      actual.origin === origin &&
      actual.origin === expected.origin
    );
  } catch {
    return false;
  }
}

export function adminRoute(call: AdminAiAccessCall) {
  return wrapRouteHandlerWithLogging(
    {
      routeId: `admin.ai-access.${call}`,
      auth: { mode: "required", getSessionUser },
    },
    async (ctx, request, user) => {
      // The wrapper has already verified any bearer through the identity resolver.
      if (
        (call === "on" || call === "off") &&
        !(await currentBearerToken()) &&
        !hasCanonicalOrigin(request.headers.get("origin"))
      ) {
        return NextResponse.json(
          { error: "origin_denied" },
          { status: 403, headers: { "cache-control": "no-store" } }
        );
      }
      let binding: Awaited<ReturnType<typeof getAdminAiAccessCalls>>;
      try {
        binding = await getAdminAiAccessCalls(user.id);
      } catch {
        ctx.log.error(
          { routeId: `admin.ai-access.${call}` },
          "agent access unavailable"
        );
        return NextResponse.json(
          { error: "authz_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } }
        );
      }
      if (!binding.ok)
        return NextResponse.json(
          { error: binding.errorCode },
          { status: binding.status, headers: { "cache-control": "no-store" } }
        );
      try {
        return send(
          await adminAiAccessHttp(deps(ctx.log), call, {
            calls: binding.calls,
            ...(call === "list"
              ? {}
              : { body: await request.json().catch(() => undefined) }),
          })
        );
      } catch {
        ctx.log.error(
          { routeId: `admin.ai-access.${call}` },
          "agent access unavailable"
        );
        return NextResponse.json(
          { error: "authz_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } }
        );
      }
    }
  );
}
