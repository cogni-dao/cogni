// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/users/me/ownership/route`
 * Purpose: API endpoint for reading the current user's ownership summary.
 * Scope: Authenticated read-only endpoint. Delegates ownership computation to the facade. Does not implement domain logic or direct persistence access.
 * Invariants:
 * - Requires authenticated user
 * - ALL_MATH_BIGINT: bigint ownership values serialized as strings
 * Side-effects: IO
 * Links: src/contracts/users.ownership.v1.contract.ts
 * @public
 */

import { ownershipSummaryOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { readOwnershipSummary } from "@/app/_facades/users/ownership.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "users.me.ownership",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, _request, sessionUser) => {
    const data = await readOwnershipSummary(sessionUser);
    const output = ownershipSummaryOperation.output.parse(data);
    return NextResponse.json(output);
  }
);
