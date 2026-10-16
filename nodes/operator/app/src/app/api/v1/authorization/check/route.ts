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
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8 * 1024;

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "authorization.facade.check", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const complete = (
      status: number,
      outcome: "success" | "error",
      errorCode: string | undefined,
      fields: Record<string, unknown> = {}
    ) =>
      logEvent(ctx.log, EVENT_NAMES.AUTHORIZATION_FACADE_CHECK_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        outcome,
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...fields,
      });
    const body = await readBoundedJson(request, MAX_REQUEST_BYTES);
    if (!body.ok) {
      const status = body.reason === "too_large" ? 413 : 400;
      complete(status, "error", body.reason);
      return NextResponse.json({ error: "invalid_request" }, { status });
    }
    const parsed = authorizationFacadeCheckOperation.input.safeParse(
      body.value
    );
    if (!parsed.success) {
      complete(400, "error", "invalid_request");
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const workload = await authenticateAuthorizationFacadeRequest(request);
    if (!workload.ok) {
      complete(workload.status, "error", workload.errorCode, {
        decision: "deny",
      });
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
    complete(
      status,
      decision.decision === "allow" ? "success" : "error",
      decision.decision === "allow" ? undefined : decision.code,
      {
        authenticatedNodeId: workload.node.nodeId,
        actorKind: parsed.data.actor.kind,
        hasSubject: parsed.data.subjectUserId !== undefined,
        billingAccountId: parsed.data.billingAccountId,
        decision: decision.decision,
        code: decision.code,
      }
    );
    const wireDecision = {
      decision: decision.decision,
      code: decision.code,
      checks: decision.checks.map((check) => ({
        name: check.name,
        user: check.user,
        relation: check.relation,
        object: check.object,
        decision: check.decision,
        code: check.code,
      })),
      ...(decision.decision === "deny" && decision.reason !== undefined
        ? { reason: decision.reason }
        : {}),
    };
    return NextResponse.json(
      authorizationFacadeCheckOperation.output.parse(wireDecision),
      { status }
    );
  }
);
