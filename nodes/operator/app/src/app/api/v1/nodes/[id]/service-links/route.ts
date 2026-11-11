// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/service-links`
 * Purpose: Start a link from the operator's `git-review` service to node X (story.0038): the operator signs
 *   a `service.enrollment.v1` token, posts it to X, and waits for X's DAO admin to click On.
 * Scope: Auth, node RBAC (`node.flight` on X), registered-origin resolution, then the link service. Holds
 *   no signing, vault or poll logic.
 * Invariants:
 *   - SAME_AUTH_AS_REVIEW: the caller is a developer of X (`node.flight` on X), the same authority that
 *     triggers a review. The operator node does not link to itself (422).
 *   - ORIGIN_FROM_REGISTRY_NEVER_BODY: the body names only the service; X's origin comes from the node
 *     registry and this operator's environment.
 *   - ONE_OPEN_LINK_PER_NODE: an open link is returned (200), a new one is 202.
 *   - NO_SECRET_IN_ANSWER: the answer carries ids, a state and `githubReady`, never a key.
 * Side-effects: IO (DB, OpenFGA check, HTTPS to node X, GitHub read), log `agent.node_link.*`
 * Links: packages/node-contracts/src/node.service-link.v1.contract.ts, story.0038,
 *   https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { startServiceLinkOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  getNodeServiceLinkService,
  resolveGithubReady,
} from "@/bootstrap/node-service-links";
import { registeredNodeOrigin } from "@/features/node-service-links/node-origin";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: "nodes.service-links.start",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, routeCtx) => {
    const { id } = await (routeCtx?.params ??
      Promise.resolve({ id: "unknown" }));
    const fail = (
      status: number,
      errorCode: string,
      extra: Record<string, unknown> = {}
    ): NextResponse => {
      ctx.log[status >= 500 ? "error" : "warn"](
        { reqId: ctx.reqId, routeId: ctx.routeId, status, errorCode, ...extra },
        "service link start refused"
      );
      return NextResponse.json({ error: errorCode, errorCode }, { status });
    };

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, "validation_error");
    }
    const parsed = startServiceLinkOperation.input.safeParse(body);
    if (!parsed.success) return fail(400, "validation_error");

    const rbac = await resolveNodeAndAuthorize({
      id,
      userId: sessionUser.id,
      action: "node.flight",
    });
    if (!rbac.ok) return fail(rbac.status, rbac.errorCode);
    const node = rbac.node;
    if (node.nodeId === getNodeId()) {
      return fail(422, "service_link_not_applicable");
    }

    const links = getNodeServiceLinkService();
    if (!links) return fail(503, "node_service_links_unavailable");

    const audience = registeredNodeOrigin({
      slug: node.slug,
      deployEnvs: node.deployEnvs,
      env: serverEnv(),
    });
    if (!audience) return fail(422, "node_not_deployed_here");

    const result = await links.start({
      nodeId: node.nodeId,
      service: parsed.data.service,
      audience,
      requestedByUserId: sessionUser.id,
    });
    if (!result.ok) {
      return fail(result.status, result.errorCode, {
        targetNodeId: node.nodeId,
      });
    }

    const output = startServiceLinkOperation.output.parse({
      linkId: result.link.id,
      nodeId: node.nodeId,
      service: result.link.service,
      state: result.link.state,
      githubReady: await resolveGithubReady(node.slug, ctx.log),
    });
    return NextResponse.json(output, { status: result.created ? 202 : 200 });
  }
);
