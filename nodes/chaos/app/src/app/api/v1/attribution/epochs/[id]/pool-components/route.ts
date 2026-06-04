// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/pool-components/route`
 * Purpose: SIWE + approver-gated endpoint for recording pool components.
 * Scope: Auth-protected POST endpoint. Requires wallet in activity_ledger.approvers. Does not contain business logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, WRITE_ROUTES_APPROVER_GATED.
 * Side-effects: IO (HTTP response, database write)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.record-pool-component.v1.contract
 * @public
 */

import { recordPoolComponentOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { toPoolComponentDto } from "@/app/api/v1/public/attribution/_lib/attribution-dto";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import {
  EVENT_NAMES,
  logEvent,
  logRequestWarn,
  type RequestContext,
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json(
      { error: "Invalid input format" },
      { status: 400 }
    );
  }
  return null;
}

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.record-pool-component",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    try {
      // WRITE_ROUTES_APPROVER_GATED
      const denied = checkApprover(ctx, sessionUser?.walletAddress);
      if (denied) return denied;

      if (!context) throw new Error("context required for dynamic routes");
      const { id } = await context.params;
      let epochId: bigint;
      try {
        epochId = BigInt(id);
      } catch {
        return NextResponse.json(
          { error: "Invalid epoch ID" },
          { status: 400 }
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      const input = recordPoolComponentOperation.input.parse(body);

      const store = getContainer().attributionStore;
      const nodeId = getNodeId();

      // input.amountCredits is already bigint (zBigint transform)
      const { component, created } = await store.insertPoolComponent({
        nodeId,
        epochId,
        componentId: input.componentId,
        algorithmVersion: input.algorithmVersion,
        inputsJson: input.inputsJson,
        amountCredits: input.amountCredits,
        evidenceRef: input.evidenceRef ?? null,
      });

      logEvent(ctx.log, EVENT_NAMES.LEDGER_POOL_COMPONENT_RECORDED, {
        reqId: ctx.reqId,
        routeId: "ledger.record-pool-component",
        epochId: id,
        componentId: input.componentId,
      });

      return NextResponse.json(
        recordPoolComponentOperation.output.parse(
          toPoolComponentDto(component)
        ),
        { status: created ? 201 : 200 }
      );
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);
