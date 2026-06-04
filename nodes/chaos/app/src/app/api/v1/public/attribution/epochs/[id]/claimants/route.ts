// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/epochs/[id]/claimants/route`
 * Purpose: Public HTTP endpoint for claimant-aware finalized epoch attribution.
 * Scope: Public route using wrapPublicRoute(); returns claimant-based finalized attribution for finalized epochs. Does not contain business logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, PUBLIC_READS_FINALIZED_ONLY.
 * Side-effects: IO (HTTP response, database read)
 * Links: src/contracts/attribution.epoch-claimants.v1.contract.ts
 * @public
 */

import { epochClaimantsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { readFinalizedEpochClaimants } from "@/app/_facades/attribution/claimants.server";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";

export const dynamic = "force-dynamic";

export const GET = wrapPublicRoute(
  {
    routeId: "ledger.epoch-claimants.public",
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
    const epoch = await store.getEpoch(epochId);
    if (!epoch || epoch.status !== "finalized") {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    return NextResponse.json(
      epochClaimantsOperation.output.parse(
        await readFinalizedEpochClaimants(epochId)
      )
    );
  }
);
