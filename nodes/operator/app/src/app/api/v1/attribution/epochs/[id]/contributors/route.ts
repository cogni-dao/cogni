// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/contributors/route`
 * Purpose: Agent-first authenticated read serving an epoch's selection-to-contributor rollup (any status, no finalized gate) plus the active attribution policy and window.
 * Scope: SIWE-or-bearer-protected GET route reusing the epoch-activity store reads and composeEpochView aggregation. Does not duplicate aggregation logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, ACTIVITY_AUTHED, SELECTION_IS_THE_GATE.
 * Side-effects: IO (HTTP response, database read)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.epoch-contributors.v1.contract
 * @public
 */

import { epochContributorsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  buildEpochContributorsView,
  EPOCH_NOT_FOUND,
} from "@/features/attribution/read/epoch-views";
import { getNodeId } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.epoch-contributors",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const store = getContainer().attributionStore;
    const view = await buildEpochContributorsView(store, getNodeId(), epochId);
    if (view === EPOCH_NOT_FOUND) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    return NextResponse.json(epochContributorsOperation.output.parse(view));
  }
);
