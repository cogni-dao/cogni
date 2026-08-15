// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/attribution/epochs`
 * Purpose: Internal endpoint the operator gateway proxies to so the owning node returns epochs from
 *   its OWN attribution ledger. The READ twin of `/api/internal/attribution/receipts` (the write
 *   plane): the operator holds no cross-node DB creds (OPERATOR_AGGREGATES_ARE_DERIVED), so it
 *   derives this aggregate over the node's internal HTTP API instead of querying a node DB.
 * Scope: Auth-protected GET that reads THIS node's own epochs. Delegates to the same
 *   `listEpochsForNode` helper the session-authed `/api/v1/attribution/epochs` uses — no duplicated
 *   aggregation, no business logic. Does not resolve nodes, run RBAC, or reach any other ledger.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN (same identity as `/receipts`).
 *   - NODE_READS_OWN_LEDGER: the `nodeId` query param MUST equal this node's own node_id; the read is
 *     scoped to `getNodeId()`. A node never reads a foreign ledger. (Mirrors the receipts route's
 *     NODE_WRITES_OWN_LEDGER envelope assertion.)
 *   - VALIDATE_IO, ALL_MATH_BIGINT: input/output validated against the frozen contract.
 * Side-effects: IO (HTTP response, database read via AttributionStore)
 * Links: attribution.epochs.internal.v1.contract,
 *   src/app/api/internal/attribution/receipts/route.ts (write twin),
 *   src/app/api/v1/attribution/epochs/route.ts (session-authed twin),
 *   src/features/attribution/read/epoch-views.ts, bug.5008
 * @internal
 */

import { internalListEpochsOperation } from "@cogni/node-contracts";
import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { listEpochsForNode } from "@/features/attribution/read/epoch-views";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "attribution.epochs.internal", auth: { mode: "none" } },
  async (ctx, request) => {
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

    const url = new URL(request.url);
    const parsed = internalListEpochsOperation.input.safeParse({
      nodeId: url.searchParams.get("nodeId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });
    if (!parsed.success) {
      log.warn({ errors: parsed.error.issues }, "Invalid request query");
      return NextResponse.json(
        { error: "Invalid request query", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { nodeId, limit, offset } = parsed.data;
    const ownNodeId = getNodeId();

    // NODE_READS_OWN_LEDGER: refuse to read a foreign node's ledger (a node holds only its own).
    if (nodeId !== ownNodeId) {
      log.warn(
        { requestedNodeId: nodeId, nodeId: ownNodeId },
        "Rejected foreign node ledger read"
      );
      return NextResponse.json(
        { error: "foreign node ledger" },
        { status: 403 }
      );
    }

    const store = getContainer().attributionStore;
    const result = await listEpochsForNode(store, ownNodeId, { limit, offset });

    return NextResponse.json(internalListEpochsOperation.output.parse(result));
  }
);
