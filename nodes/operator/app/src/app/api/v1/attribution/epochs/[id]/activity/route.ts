// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/activity/route`
 * Purpose: Authenticated HTTP endpoint for epoch activity — UNION of window receipts and epoch-selected receipts with selection join.
 * Scope: SIWE-protected route; exposes PII fields (platformUserId, platformLogin, etc.). Does not contain business logic. Displays cross-epoch promoted receipts alongside window receipts.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, ACTIVITY_AUTHED.
 * Side-effects: IO (HTTP response, database read)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.epoch-activity.v1.contract
 * @public
 */

import { epochActivityOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  buildEpochActivityView,
  EPOCH_NOT_FOUND,
} from "@/features/attribution/read/epoch-views";
import { getNodeId } from "@/shared/config";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.epoch-activity",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const url = new URL(request.url);
    const { limit, offset } = epochActivityOperation.input.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });

    const store = getContainer().attributionStore;
    const view = await buildEpochActivityView(
      store,
      getNodeId(),
      epochId,
      id,
      { limit, offset },
      ({ resolvedCount, unresolvedCount }) => {
        logEvent(ctx.log, EVENT_NAMES.LEDGER_IDENTITY_RESOLVED_AT_READ, {
          reqId: ctx.reqId,
          routeId: "ledger.epoch-activity",
          epochId: id,
          resolvedCount,
          unresolvedCount,
        });
      }
    );
    if (view === EPOCH_NOT_FOUND) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    return NextResponse.json(epochActivityOperation.output.parse(view));
  }
);
