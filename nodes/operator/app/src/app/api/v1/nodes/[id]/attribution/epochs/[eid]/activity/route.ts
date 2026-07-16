// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/attribution/epochs/[eid]/activity/route`
 * Purpose: Node-addressable read of ANY registered node's epoch activity (window ∪ epoch-selected
 *   receipts with selection join) from the operator gateway — the same union the operator-self
 *   `/api/v1/attribution/epochs/[id]/activity` returns, but for the node resolved from `{id}`.
 * Scope: Thin HTTP shell — auth (bearer-or-session, mirroring the operator-self read), resolve
 *   `{id}` AND authorize the caller on it via the shared `resolveNodeAndAuthorize` seam, then
 *   delegate to the node-id-parameterized `buildEpochActivityView` helper. No duplicated
 *   aggregation logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, PER_NODE_RBAC (hard-reject cross-node
 *   reads — the caller must be authorized on THIS node via `resolveNodeAndAuthorize`/`node.flight`
 *   or the route returns 403 `authz_denied` / 503 `authz_unavailable`; unknown node → 404). Exposes
 *   PII fields (platformUserId/Login) like its twin, so the per-node gate is load-bearing.
 * Side-effects: IO (HTTP response, service-db node resolution, OpenFGA check, database read;
 *   background selection userId updates on read-time identity resolution)
 * Links: src/features/attribution/read/epoch-views.ts, src/app/_lib/node-rbac.ts,
 *   src/app/api/v1/attribution/epochs/[id]/activity/route.ts (operator-self twin)
 * @public
 */

import { epochActivityOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  buildEpochActivityView,
  EPOCH_NOT_FOUND,
} from "@/features/attribution/read/epoch-views";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string; eid: string }>;
}>(
  {
    routeId: "nodes.attribution.epoch-activity",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id, eid } = await context.params;

    let epochId: bigint;
    try {
      epochId = BigInt(eid);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    // Hard-reject cross-node reads: resolve {id} AND authorize the caller on THIS node
    // (`node.flight` = the developer-tier per-node access relation) before exposing its
    // PII-bearing activity. Deny → 403; no store → 503; unknown → 404.
    const authz = await resolveNodeAndAuthorize({
      id,
      userId: sessionUser.id,
      action: "node.flight",
    });
    if (!authz.ok) {
      return NextResponse.json(
        { error: authz.errorCode },
        { status: authz.status }
      );
    }
    const node = authz.node;

    const url = new URL(request.url);
    const { limit, offset } = epochActivityOperation.input.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });

    const store = getContainer().attributionStore;
    const view = await buildEpochActivityView(
      store,
      node.nodeId,
      epochId,
      eid,
      { limit, offset },
      ({ resolvedCount, unresolvedCount }) => {
        logEvent(ctx.log, EVENT_NAMES.LEDGER_IDENTITY_RESOLVED_AT_READ, {
          reqId: ctx.reqId,
          routeId: "nodes.attribution.epoch-activity",
          epochId: eid,
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
