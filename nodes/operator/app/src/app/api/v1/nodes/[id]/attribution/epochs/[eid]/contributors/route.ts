// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/attribution/epochs/[eid]/contributors/route`
 * Purpose: Node-addressable read of ANY registered node's epoch contributor rollup from the
 *   operator gateway — the same selection-to-contributor aggregation the operator-self
 *   `/api/v1/attribution/epochs/[id]/contributors` returns, but for the node resolved from `{id}`.
 * Scope: Thin HTTP shell — auth (bearer-or-session, mirroring the operator-self read), resolve
 *   `{id}` AND authorize the caller on it via the shared `resolveNodeAndAuthorize` seam, then
 *   delegate to the node-id-parameterized `buildEpochContributorsView` helper. No duplicated
 *   aggregation logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, SELECTION_IS_THE_GATE (any status, no finalized
 *   gate), PER_NODE_RBAC (hard-reject cross-node reads — the caller must be authorized on THIS
 *   node via `resolveNodeAndAuthorize`/`node.flight` or the route returns 403 `authz_denied` /
 *   503 `authz_unavailable`; unknown node → 404 `node_not_found`). Exposes contributor identities,
 *   so the per-node gate is load-bearing.
 * Side-effects: IO (HTTP response, service-db node resolution, OpenFGA check, database read)
 * Links: src/features/attribution/read/epoch-views.ts, src/app/_lib/node-rbac.ts,
 *   src/app/api/v1/attribution/epochs/[id]/contributors/route.ts (operator-self twin)
 * @public
 */

import { epochContributorsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  buildEpochContributorsView,
  EPOCH_NOT_FOUND,
} from "@/features/attribution/read/epoch-views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string; eid: string }>;
}>(
  {
    routeId: "nodes.attribution.epoch-contributors",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, sessionUser, context) => {
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
    // contributor identities. Deny → 403; no store → 503; unknown → 404.
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

    const store = getContainer().attributionStore;
    const view = await buildEpochContributorsView(store, node.nodeId, epochId);
    if (view === EPOCH_NOT_FOUND) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    return NextResponse.json(epochContributorsOperation.output.parse(view));
  }
);
