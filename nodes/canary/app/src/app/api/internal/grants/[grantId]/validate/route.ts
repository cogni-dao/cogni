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
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  isGrantExpiredError,
  isGrantNotFoundError,
  isGrantRevokedError,
  isGrantScopeMismatchError,
} from "@/ports/server";
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

    const { graphId } = parsed.data;
    const container = getContainer();

    try {
      const grant =
        await container.executionGrantWorkerPort.validateGrantForGraph(
          SYSTEM_ACTOR,
          grantId,
          graphId
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
      else if (isGrantScopeMismatchError(err))
        errorCode = "grant_scope_mismatch";

      if (errorCode) {
        log.info({ grantId, graphId, errorCode }, "Grant validation rejected");
        const response: InternalValidateGrantError = {
          ok: false,
          error: errorCode,
        };
        return NextResponse.json(response, { status: 403 });
      }

      log.error({ grantId, graphId, err }, "Unexpected error validating grant");
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }
);
