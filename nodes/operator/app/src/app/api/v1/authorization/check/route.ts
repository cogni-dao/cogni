// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/authorization/check`
 * Purpose: Mediate a node workload's same-node billing-account read check.
 * Scope: Workload auth, strict HTTP validation, policy delegation, audit response.
 * Invariants: NODE_FROM_CREDENTIAL; BILLING_ACCOUNT_READ_ONLY; DENY_UNAVAILABLE_DISTINCT.
 * Side-effects: OpenBao, DB, OpenFGA IO and structured audit logging.
 * Links: task.5226, @features/authorization
 * @public
 */

import type { AuthzDecision } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { authenticateAuthorizationFacadeRequest } from "@/app/_lib/authorization-facade-auth";
import { readBoundedJson } from "@/app/_lib/bounded-json-body";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { authorizationFacadeCheckOperation } from "@/contracts/authorization-facade.v1.contract";
import { checkNodeBillingAccountAccess } from "@/features/authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8 * 1024;

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "authorization.facade.check", auth: { mode: "none" } },
  async (ctx, request) => {
    const body = await readBoundedJson(request, MAX_REQUEST_BYTES);
    if (!body.ok) {
      return NextResponse.json(
        { error: "invalid_request" },
        { status: body.reason === "too_large" ? 413 : 400 }
      );
    }
    const parsed = authorizationFacadeCheckOperation.input.safeParse(
      body.value
    );
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const workload = await authenticateAuthorizationFacadeRequest(request);
    if (!workload.ok) {
      ctx.log.warn(
        { decision: "deny", code: workload.errorCode },
        "authorization_facade.authentication_denied"
      );
      return NextResponse.json(
        {
          error:
            workload.status === 401
              ? "authorization_facade_denied"
              : "authorization_facade_unavailable",
        },
        { status: workload.status }
      );
    }

    const authorization = getContainer().authorization;
    const decision: AuthzDecision = authorization
      ? await checkNodeBillingAccountAccess(
          { authorization },
          workload.node.nodeId,
          parsed.data
        )
      : {
          decision: "deny",
          code: "authz_unavailable",
          checks: [],
          reason: "operator authorization unavailable",
        };
    const status =
      decision.decision === "allow"
        ? 200
        : decision.code === "authz_unavailable"
          ? 503
          : 403;
    ctx.log.info(
      {
        authenticatedNodeId: workload.node.nodeId,
        actorKind: parsed.data.actor.kind,
        actorId: parsed.data.actor.id,
        subjectUserId: parsed.data.subjectUserId,
        billingAccountId: parsed.data.billingAccountId,
        decision: decision.decision,
        code: decision.code,
        requestId: ctx.reqId,
      },
      "authorization_facade.check_decided"
    );
    return NextResponse.json(
      authorizationFacadeCheckOperation.output.parse(decision),
      { status }
    );
  }
);
