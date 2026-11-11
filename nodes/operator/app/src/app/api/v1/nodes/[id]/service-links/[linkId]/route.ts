// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/service-links/[linkId]`
 * Purpose: Read one service link, driving its poll one step (GET), or drop the operator's copy (DELETE).
 * Scope: Auth, node RBAC (`node.flight` on X), then the link service. The poll step opens the sealed key
 *   inside the service; this handler only ever returns a state and a connection id.
 * Invariants:
 *   - POLL_DRIVER_NO_TEMPORAL: this GET and the review start are the only poll drivers; each runs at
 *     most one step, at least 5 s after the last.
 *   - SAME_AUTH_AS_REVIEW: `node.flight` on X.
 *   - LINK_BELONGS_TO_NODE: a link id under another node answers 404.
 *   - DELETE_DROPS_THE_OPERATORS_COPY: it revokes the stored key and marks the link `superseded`. X's own
 *     cut-off is Off on its row or revoking the key on X.
 * Side-effects: IO (DB, OpenFGA check, HTTPS to node X while polling)
 * Links: packages/node-contracts/src/node.service-link.v1.contract.ts, story.0038
 * @public
 */

import { serviceLinkOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeServiceLinkService } from "@/bootstrap/node-service-links";
import type { NodeServiceLinkRecord } from "@/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface RouteParams {
  params: Promise<{ id: string; linkId: string }>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function view(link: NodeServiceLinkRecord) {
  return serviceLinkOperation.output.parse({
    linkId: link.id,
    nodeId: link.nodeId,
    service: link.service,
    state: link.state,
    ...(link.connectionId && link.state === "connected"
      ? { connectionId: link.connectionId }
      : {}),
    ...(link.failureCode &&
    (link.state === "failed" || link.state === "needs_reenroll")
      ? { failureCode: link.failureCode }
      : {}),
  });
}

async function handle(
  method: "GET" | "DELETE",
  ctx: Parameters<Parameters<typeof wrapRouteHandlerWithLogging>[1]>[0],
  sessionUser: { id: string },
  routeCtx: RouteParams | undefined
): Promise<NextResponse> {
  const { id, linkId } = await (routeCtx?.params ??
    Promise.resolve({ id: "unknown", linkId: "unknown" }));
  const fail = (status: number, errorCode: string): NextResponse => {
    ctx.log[status >= 500 ? "error" : "warn"](
      { reqId: ctx.reqId, routeId: ctx.routeId, status, errorCode },
      "service link request refused"
    );
    return NextResponse.json({ error: errorCode, errorCode }, { status });
  };

  if (!UUID_RE.test(linkId)) return fail(404, "link_not_found");
  const rbac = await resolveNodeAndAuthorize({
    id,
    userId: sessionUser.id,
    action: "node.flight",
  });
  if (!rbac.ok) return fail(rbac.status, rbac.errorCode);

  const links = getNodeServiceLinkService();
  if (!links) return fail(503, "node_service_links_unavailable");

  if (method === "GET") {
    const link = await links.get(rbac.node.nodeId, linkId);
    return link ? NextResponse.json(view(link)) : fail(404, "link_not_found");
  }
  const existing = await links.find(rbac.node.nodeId, linkId);
  if (!existing) return fail(404, "link_not_found");
  await links.remove(existing);
  return NextResponse.json({ linkId, state: "superseded" });
}

export const GET = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: "nodes.service-links.read",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, routeCtx) =>
    handle("GET", ctx, sessionUser, routeCtx)
);

export const DELETE = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: "nodes.service-links.remove",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, routeCtx) =>
    handle("DELETE", ctx, sessionUser, routeCtx)
);
