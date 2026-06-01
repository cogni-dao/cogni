// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/epochs/route`
 * Purpose: Public HTTP endpoint for listing closed (finalized) ledger epochs.
 * Scope: Public route using wrapPublicRoute(); only returns finalized epochs. Does not expose open/review epoch data.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, PUBLIC_READS_FINALIZED_ONLY.
 * Side-effects: IO (HTTP response, database read)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.list-epochs.v1.contract
 * @public
 */

import { listEpochsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { toEpochDto } from "@/app/api/v1/public/attribution/_lib/attribution-dto";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";

export const dynamic = "force-dynamic";

export const GET = wrapPublicRoute(
  {
    routeId: "ledger.list-epochs.public",
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 300,
  },
  async (_ctx, request) => {
    const url = new URL(request.url);
    const { limit, offset } = listEpochsOperation.input.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });

    const store = getContainer().attributionStore;
    const allEpochs = await store.listEpochs(getNodeId());
    // PUBLIC_READS_FINALIZED_ONLY: only expose finalized epochs
    const finalizedEpochs = allEpochs.filter((e) => e.status === "finalized");
    const page = finalizedEpochs.slice(offset, offset + limit);

    return NextResponse.json(
      listEpochsOperation.output.parse({
        epochs: page.map(toEpochDto),
        total: finalizedEpochs.length,
      })
    );
  }
);
