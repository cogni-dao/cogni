// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/grants/[grantId]/validate`
 * Purpose: Internal endpoint for scheduler-worker to validate an execution grant against a graph.
 * Scope: Auth-protected POST — delegates to ExecutionGrantWorkerPort.validateGrantForGraph. Worker holds no DB credentials; this is the only validation path.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN
 *   - 403 on grant-not-found/expired/revoked/scope-mismatch with machine-readable error code
 * Side-effects: IO (reads grants via ExecutionGrantWorkerPort)
 * Links: grants.validate.internal.v1.contract, task.0280
 * @internal
 */

import { SYSTEM_ACTOR } from "@cogni/ids/system";
import {
  type InternalValidateGrantError,
  InternalValidateGrantInputSchema,
  type InternalValidateGrantOutput,
} from "@cogni/node-contracts";
import { verifySchedulerBearer } from "@cogni/node-shared";
import { graphExecuteScope } from "@cogni/scheduler-core";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  isGrantExpiredError,
  isGrantNodeMismatchError,
  isGrantNotFoundError,
  isGrantRevokedError,
  isGrantScopeMismatchError,
} from "@/ports/server";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ grantId: string }>;
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "grants.validate.internal", auth: { mode: "none" } },
  async (ctx, request, _sessionUser, routeParams) => {
    const env = serverEnv();
    const log = ctx.log;

    if (
      !verifySchedulerBearer(
        request.headers.get("authorization"),
        env.SCHEDULER_API_TOKEN
      )
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!routeParams) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { grantId } = await routeParams.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = InternalValidateGrantInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const ownNodeId = getNodeId();
    // M1 grant↔node binding: the worker tells us which node it is dispatching
    // for. The request reached THIS node's URL, so a mismatch means a routing /
    // spoofing bug — fail closed before touching the grant.
    const dispatchNodeId = parsed.data.nodeId ?? ownNodeId;
    if (parsed.data.nodeId && parsed.data.nodeId !== ownNodeId) {
      log.warn(
        { grantId, requestedNodeId: parsed.data.nodeId, ownNodeId },
        "Grant validation node mismatch (request reached the wrong node)"
      );
      const response: InternalValidateGrantError = {
        ok: false,
        error: "grant_node_mismatch",
      };
      return NextResponse.json(response, { status: 403 });
    }

    // M2 scope generalization: prefer the explicit `scope`; otherwise derive
    // the graph scope from the back-compat `graphId`.
    const requiredScope =
      parsed.data.scope ??
      (parsed.data.graphId ? graphExecuteScope(parsed.data.graphId) : null);
    if (!requiredScope) {
      return NextResponse.json(
        { error: "one of `scope` or `graphId` is required" },
        { status: 400 }
      );
    }

    const container = getContainer();

    try {
      const grant =
        await container.executionGrantWorkerPort.validateGrantForScope(
          SYSTEM_ACTOR,
          dispatchNodeId,
          grantId,
          requiredScope
        );
      const response: InternalValidateGrantOutput = {
        ok: true,
        grant: {
          id: grant.id,
          userId: grant.userId,
          billingAccountId: grant.billingAccountId,
          scopes: [...grant.scopes],
          expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
          revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
          createdAt: grant.createdAt.toISOString(),
        },
      };
      return NextResponse.json(response, { status: 200 });
    } catch (err) {
      let errorCode: InternalValidateGrantError["error"] | null = null;
      if (isGrantNotFoundError(err)) errorCode = "grant_not_found";
      else if (isGrantExpiredError(err)) errorCode = "grant_expired";
      else if (isGrantRevokedError(err)) errorCode = "grant_revoked";
      else if (isGrantNodeMismatchError(err)) errorCode = "grant_node_mismatch";
      else if (isGrantScopeMismatchError(err))
        errorCode = "grant_scope_mismatch";

      if (errorCode) {
        log.info(
          { grantId, requiredScope, errorCode },
          "Grant validation rejected"
        );
        const response: InternalValidateGrantError = {
          ok: false,
          error: errorCode,
        };
        return NextResponse.json(response, { status: 403 });
      }

      log.error(
        { grantId, requiredScope, err },
        "Unexpected error validating grant"
      );
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }
);
