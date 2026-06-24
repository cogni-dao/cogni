// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/compute/balances`
 * Purpose: On-demand READ of each compute-provider account balance (story.5011) — the
 *   pull surface for the dashboard fleet view, and the side that refreshes the
 *   compute_balance_remaining Prometheus gauge for Grafana alerting.
 * Scope: Session-gated GET that delegates to ComputeResourcePort.balances() and sets the
 *   gauge. Does not provision/release compute or settle payment (the deferred write half).
 * Invariants: Session required; provider-agnostic ComputeBalance returned verbatim; empty
 *   array when CHERRY_AUTH_TOKEN is unset (graceful stub).
 * Side-effects: IO (HTTPS read to the compute provider; sets the metrics gauge).
 * Links: ComputeResourcePort (@cogni/ai-tools), shared/observability computeBalanceRemaining.
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { computeBalanceRemaining } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "compute.balances", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, _sessionUser) => {
    const container = getContainer();
    const balances = await container.computeCapability.balances();

    // Refresh the alertable gauge from the same read that serves the dashboard.
    for (const b of balances) {
      computeBalanceRemaining
        .labels({
          provider: b.provider,
          account: b.accountId,
          currency: b.currency,
        })
        .set(b.remaining);
    }

    return NextResponse.json({ balances });
  }
);
