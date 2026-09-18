// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/compute/balances`
 * Purpose: On-demand READ of compute spend-awareness (story.5011/story.5013) — provider
 *   account balances where a read credential exists (Cherry), and the Akash spend view from
 *   the actuator's OWN cost ledger (task.5138: "cost rows follow the writer").
 * Scope: Session-gated GET. Does not provision/release compute or settle payment.
 * Invariants:
 *   - ONE_CONSOLE_KEY_PER_ACCOUNT (hub `akash-actuator-wallet-cutover`): this route reads NO
 *     Akash Console API. The account's one key belongs to its actuator; the app's Akash view
 *     is the ledger the writer itself populates (per-node transferred totals + active rates).
 *   - Session required; `balances` returned verbatim from ComputeResourcePort; `akashSpend`
 *     is null (never fabricated) until AKASH_ACTUATOR_ACCOUNT_ID is pinned on the runtime.
 * Side-effects: IO (Cherry HTTPS read; Postgres cost-ledger read).
 * Links: ComputeResourcePort (@cogni/ai-tools), DrizzleComputeCostStore (adapters/server/compute),
 *   task.5138, story.5039.
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
    const container = getContainer();
    const spendReader = container.akashSpendReader;
    const [balances, akashSpend] = await Promise.all([
      container.computeCapability.balances(),
      spendReader
        ? (async () => ({
            accountId: spendReader.accountId,
            asOf: new Date().toISOString(),
            byNode: await spendReader.reportByNode(),
          }))()
        : Promise.resolve(null),
    ]);
    return NextResponse.json({ balances, akashSpend });
  }
);
