// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/authorization/billing-account-grants`
 * Purpose: Apply a bounded same-node reader or account-scoped OBO grant/revoke.
 * Scope: Workload auth, strict semantic validation, policy delegation, audit response.
 * Invariants: GRANTOR_CAN_GRANT; NO_RAW_TUPLES; NO_OWNER_OR_NODE_ROLE_WRITES; HIGHER_CONSISTENCY.
 * Side-effects: OpenBao, DB, OpenFGA IO and structured audit logging.
 * Links: task.5226, @features/authorization
 * @public
 */

import type { AuthzWriteDecision } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { authenticateAuthorizationFacadeRequest } from "@/app/_lib/authorization-facade-auth";
import { readBoundedJson } from "@/app/_lib/bounded-json-body";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { authorizationFacadeGrantOperation } from "@/contracts/authorization-facade.v1.contract";
import { mutateNodeBillingAccountAccess } from "@/features/authorization";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8 * 1024;

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "authorization.facade.billing_account_grant",
    auth: { mode: "none" },
  },
  async (ctx, request) => {
    const startedAt = performance.now();
    const complete = (
      status: number,
      outcome: "success" | "error",
      errorCode: string | undefined,
      fields: Record<string, unknown> = {}
    ) =>
      logEvent(ctx.log, EVENT_NAMES.AUTHORIZATION_FACADE_GRANT_COMPLETE, {
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
    const parsed = authorizationFacadeGrantOperation.input.safeParse(
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
    const decision: AuthzWriteDecision = authorization
      ? await mutateNodeBillingAccountAccess(
          { authorization },
          workload.node.nodeId,
          parsed.data
        )
      : {
          decision: "failure",
          code: "authz_write_unavailable",
          reason: "operator authorization unavailable",
        };
    const status =
      decision.decision === "success"
        ? 200
        : decision.code === "authz_write_denied"
          ? 403
          : 503;
    complete(
      status,
      decision.decision === "success" ? "success" : "error",
      decision.decision === "success" ? undefined : decision.code,
      {
        authenticatedNodeId: workload.node.nodeId,
        assertedGrantorUserId: parsed.data.grantorUserId,
        billingAccountId: parsed.data.billingAccountId,
        operation: parsed.data.operation,
        role: parsed.data.role,
        targetKind: parsed.data.target.kind,
        hasSubject: parsed.data.subjectUserId !== undefined,
        decision: decision.decision,
        code: decision.code,
        requestId: parsed.data.requestId ?? ctx.reqId,
      }
    );
    return NextResponse.json(
      authorizationFacadeGrantOperation.output.parse(decision),
      { status }
    );
  }
);
