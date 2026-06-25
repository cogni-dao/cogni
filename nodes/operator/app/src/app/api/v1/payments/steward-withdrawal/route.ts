// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/payments/steward-withdrawal`
 * Purpose: The "TRIGGER" rung of the manual provider top-up flow — an approver-gated
 *   POST that funds the human-custodied steward wallet from the operator wallet via a
 *   single pinned USDC transfer, so a human can then settle vendor invoices (OpenRouter,
 *   Cherry) through each vendor's hosted crypto checkout. See docs/design/node-steward-wallet.md.
 * Scope: Session + steward-self-authorized. Delegates to OperatorWalletPort.withdrawToSteward
 *   (destination is repo-spec-pinned, caller picks amount only). Does NOT complete the vendor
 *   checkout (human step) or read provider balances (separate surface).
 * Invariants:
 *   - STEWARD_SELF_AUTHORIZED — only the configured steward wallet may trigger a withdrawal to itself.
 *   - STEWARD_PINNED_DESTINATION — destination is payments_out.steward_wallet, never caller-supplied.
 *   - FAIL_CLOSED — 503 when the operator/steward wallet is unconfigured in this environment.
 * Side-effects: IO (on-chain USDC transfer via Privy HSM; structured log event).
 * Links: docs/design/node-steward-wallet.md, OperatorWalletPort.withdrawToSteward
 * @public
 */

import { EVENT_NAMES } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getStewardWalletConfig } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** USDC has 6 decimals on Base. */
const USDC_DECIMALS = 6;

/** Manual top-ups are small; a hard request ceiling backs the adapter's per-tx cap. */
const StewardWithdrawalSchema = z.object({
  amountUsd: z.number().positive().max(10_000),
});

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "payments.steward-withdrawal",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    // STEWARD_SELF_AUTHORIZED — only the configured steward wallet may trigger this.
    // (At MVP the steward wallet IS the governance approver/admin wallet.)
    const stewardConfig = getStewardWalletConfig();
    if (!stewardConfig) {
      return NextResponse.json(
        {
          error: "Steward wallet not configured",
          code: "STEWARD_UNCONFIGURED",
        },
        { status: 503 }
      );
    }
    const callerWallet = sessionUser?.walletAddress;
    if (
      !callerWallet ||
      callerWallet.toLowerCase() !== stewardConfig.address.toLowerCase()
    ) {
      ctx.log.warn(
        { caller: callerWallet ? `${callerWallet.slice(0, 10)}...` : null },
        "steward_withdrawal_not_authorized"
      );
      return NextResponse.json(
        { error: "Not authorized as steward" },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = StewardWithdrawalSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const operatorWallet = getContainer().operatorWallet;
    if (!operatorWallet) {
      // FAIL_CLOSED — Privy / operator wallet not wired in this environment.
      return NextResponse.json(
        {
          error: "Operator wallet not configured",
          code: "OPERATOR_WALLET_UNCONFIGURED",
        },
        { status: 503 }
      );
    }

    const { amountUsd } = parsed.data;
    const amountUsdcAtomic = BigInt(
      Math.round(amountUsd * 10 ** USDC_DECIMALS)
    );

    let txHash: string;
    try {
      txHash = await operatorWallet.withdrawToSteward(amountUsdcAtomic);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // STEWARD_NOT_CONFIGURED / cap / amount guards surface here as fail-closed.
      ctx.log.warn({ amountUsd, error: detail }, "steward_withdrawal_rejected");
      return NextResponse.json(
        { error: "Steward withdrawal rejected", detail },
        { status: 422 }
      );
    }

    ctx.log.info(
      {
        event: EVENT_NAMES.PAYMENTS_STEWARD_WITHDRAWAL,
        txHash,
        amountUsd,
        amountUsdcAtomic: amountUsdcAtomic.toString(),
        steward: stewardConfig.address,
      },
      "steward wallet funded"
    );

    return NextResponse.json({ txHash, amountUsd }, { status: 200 });
  }
);
