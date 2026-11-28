// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authenticated callers may only ask for their own access; the package owns the wire contract. */
import {
  accessRequestCreateHttp,
  accessRequestListHttp,
} from "@cogni-dao/agent-grants/http";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAgentToolAuthority } from "@/bootstrap/agent-tool-authority";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import { deps, send } from "../../admin/ai-access/respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const via = (request: Request): "bearer" | "session" => {
  const value = request.headers.get("authorization");
  return value?.toLowerCase().startsWith("bearer ") &&
    value.slice(7).trimStart()
    ? "bearer"
    : "session";
};
export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access.requests.list",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, user) =>
    send(
      await accessRequestListHttp(deps(ctx.log), {
        via: via(request),
        principalUserId: user.id,
        authority: {
          listOwnAccess: async (id) =>
            (await getAgentToolAuthority()).listOwnAccess(id),
        },
      })
    )
);
export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access.requests.create",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, user) => {
    const configured = serverEnv().APP_BASE_URL;
    let origin: string;
    try {
      if (!configured) throw new Error("missing origin");
      const url = new URL(configured);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("invalid origin");
      origin = url.origin;
    } catch {
      return NextResponse.json(
        { error: "authz_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } }
      );
    }
    if (via(request) === "session" && request.headers.get("origin") !== origin)
      return NextResponse.json(
        { error: "forbidden" },
        { status: 403, headers: { "cache-control": "no-store" } }
      );
    return send(
      await accessRequestCreateHttp(deps(ctx.log), {
        via: via(request),
        principalUserId: user.id,
        body: await request.json().catch(() => undefined),
        origin,
        authority: {
          requestAccess: async (input) =>
            (await getAgentToolAuthority()).requestAccess(input),
        },
      })
    );
  }
);
