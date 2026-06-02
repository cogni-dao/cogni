// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/route`
 * Purpose: Authenticated HTTP endpoint for listing all ledger epochs (including open).
 * Scope: SIWE-protected route; returns all epochs for the current node. Does not contain business logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, WRITE_ROUTES_AUTHED.
 * Side-effects: IO (HTTP response, database read)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.list-epochs.v1.contract
 * @public
 */

import { listEpochsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { toEpochDto } from "@/app/api/v1/public/attribution/_lib/attribution-dto";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "ledger.list-epochs",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request) => {
    const url = new URL(request.url);
    const { limit, offset } = listEpochsOperation.input.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });

    const store = getContainer().attributionStore;
    const allEpochs = await store.listEpochs(getNodeId());
    const page = allEpochs.slice(offset, offset + limit);

    return NextResponse.json(
      listEpochsOperation.output.parse({
        epochs: page.map(toEpochDto),
        total: allEpochs.length,
      })
    );
  }
);
