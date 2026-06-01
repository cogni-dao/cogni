// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/treasury/snapshot/route`
 * Purpose: Public HTTP endpoint for DAO treasury balance snapshots.
 * Scope: Public route using wrapPublicRoute(); delegates to facade with timeout; returns 200 even on RPC failure (with staleWarning). Does not perform RPC calls directly.
 * Invariants: Always returns 200; staleWarning indicates RPC timeout/error; validates output with contract; rate limit + cache via wrapPublicRoute().
 * Side-effects: IO (HTTP response, RPC via TreasuryReadPort through facade)
 * Notes: USDC balance only. No client-side polling - called once per page load. wrapPublicRoute() auto-applies rate limiting (10 req/min/IP + burst 5) and cache headers (120s + swr 300s).
 * Links: docs/spec/onchain-readers.md, bootstrap/http/wrapPublicRoute.ts
 * @public
 */

import { TreasurySnapshotResponseV1 } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getTreasurySnapshotFacade } from "@/app/_facades/treasury/snapshot.server";
import { wrapPublicRoute } from "@/bootstrap/http";

export const dynamic = "force-dynamic";

export const GET = wrapPublicRoute(
  {
    routeId: "treasury.snapshot",
    cacheTtlSeconds: 120, // 2 minutes - matches staleTime in useTreasurySnapshot
    staleWhileRevalidateSeconds: 300, // 5 minutes
  },
  async (ctx) => {
    // Call facade - returns staleWarning on RPC failure instead of throwing
    const result = await getTreasurySnapshotFacade(ctx);

    // Validate output and return
    return NextResponse.json(TreasurySnapshotResponseV1.parse(result));
  }
);
