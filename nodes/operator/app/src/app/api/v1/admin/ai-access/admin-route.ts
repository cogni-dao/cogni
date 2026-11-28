// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Admin identity and the node-admin gate precede every shared access operation. */
import {
  type AdminAiAccessCall,
  adminAiAccessHttp,
} from "@cogni-dao/agent-grants/http";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAdminAiAccessCalls } from "@/bootstrap/agent-tool-authority";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { deps, send } from "./respond";
export function adminRoute(call: AdminAiAccessCall) {
  return wrapRouteHandlerWithLogging(
    {
      routeId: `admin.ai-access.${call}`,
      auth: { mode: "required", getSessionUser },
    },
    async (ctx, request, user) => {
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
      return send(
        await adminAiAccessHttp(deps(ctx.log), call, {
          calls: binding.calls,
          ...(call === "list"
            ? {}
            : { body: await request.json().catch(() => undefined) }),
        })
      );
    }
  );
}
