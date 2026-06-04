// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/user-projections/route`
 * Purpose: Read-only epoch user projections endpoint + deprecated PATCH (410 Gone).
 * Scope: Auth-protected GET endpoint for listing unsigned user projections. PATCH returns 410 — use review-subject-overrides instead. Does not perform override writes or finalization logic.
 * Invariants: NODE_SCOPED, VALIDATE_IO.
 * Side-effects: IO (HTTP response, database read)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.epoch-user-projections.v1.contract
 * @public
 */

import { epochUserProjectionsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { toUserProjectionDto } from "@/app/api/v1/public/attribution/_lib/attribution-dto";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.epoch-user-projections",
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
    const epoch = await store.getEpoch(epochId);
    if (!epoch) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    const userProjections = await store.getUserProjectionsForEpoch(epochId);

    return NextResponse.json(
      epochUserProjectionsOperation.output.parse({
        userProjections: userProjections.map(toUserProjectionDto),
        epochId: id,
      })
    );
  }
);

export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.update-user-projections",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, _sessionUser, _context) => {
    return NextResponse.json(
      {
        error:
          "Per-user projection edits are deprecated. Use PATCH /epochs/[id]/review-subject-overrides for review-phase editing.",
      },
      { status: 410 }
    );
  }
);
