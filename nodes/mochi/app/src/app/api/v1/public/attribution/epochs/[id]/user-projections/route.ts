// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/epochs/[id]/user-projections/route`
 * Purpose: Public HTTP endpoint for epoch user projections (finalized epochs only).
 * Scope: Public route using wrapPublicRoute(); returns unsigned per-user projections for finalized epochs. Does not contain business logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, PUBLIC_READS_FINALIZED_ONLY.
 * Side-effects: IO (HTTP response, database read)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.epoch-user-projections.v1.contract
 * @public
 */

import { epochUserProjectionsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { toUserProjectionDto } from "@/app/api/v1/public/attribution/_lib/attribution-dto";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";

export const dynamic = "force-dynamic";

export const GET = wrapPublicRoute(
  {
    routeId: "ledger.epoch-user-projections.public",
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 300,
  },
  async (_ctx, _request, context) => {
    const { id } = await (context as { params: Promise<{ id: string }> })
      .params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const store = getContainer().attributionStore;

    // PUBLIC_READS_FINALIZED_ONLY: verify epoch is finalized
    const epoch = await store.getEpoch(epochId);
    if (!epoch || epoch.status !== "finalized") {
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
