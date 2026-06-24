// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/compute/balances`
 * Purpose: On-demand READ of each compute-provider account balance (story.5011) — the
 *   RBAC-gated pull surface for the dashboard fleet view (story.5013) and agents.
 * Scope: Session-gated GET that delegates to the injected ComputeResourcePort. Does not
 *   provision/release compute, settle payment (the deferred write half), or emit metrics.
 * Invariants: Session required; provider-agnostic ComputeBalance returned verbatim; empty
 *   array when CHERRY_AUTH_TOKEN is unset (graceful stub).
 * Side-effects: IO (HTTPS read to the compute provider via the adapter).
 * Links: ComputeResourcePort (@cogni/ai-tools), CherryComputeAdapter (adapters/server/compute).
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "compute.balances", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, _sessionUser) => {
    const balances = await getContainer().computeCapability.balances();
    return NextResponse.json({ balances });
  }
);
