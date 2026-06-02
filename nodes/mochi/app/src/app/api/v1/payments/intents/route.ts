// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/payments/intents`
 * Purpose: HTTP endpoint to create payment intents with on-chain transfer parameters.
 * Scope: Validates request/response with contract, enforces SIWE session, delegates to facade; does not perform database access directly.
 * Invariants: Billing account derived from session only; amount bounds validated at contract level.
 * Side-effects: IO (creates payment_attempts record and payment_events log via PaymentAttemptRepository port).
 * Notes: Returns on-chain transfer params (chainId, token, to, amountRaw) for client to execute USDC transfer.
 * Links: docs/spec/payments-design.md
 * @public
 */

import { paymentIntentOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { createPaymentIntentFacade } from "@/app/_facades/payments/attempts.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  AuthUserNotFoundError,
  WalletRequiredError,
} from "@/features/payments/errors";
import { logRequestWarn, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";

/**
 * Local error handler for payment intent route.
 * Maps domain errors to HTTP responses; returns null for unhandled errors.
 */
function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  // Zod validation errors
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json(
      { error: "Invalid input format" },
      { status: 400 }
    );
  }

  // Auth errors
  if (error instanceof AuthUserNotFoundError) {
    logRequestWarn(ctx.log, error, "AUTH_USER_NOT_FOUND");
    return NextResponse.json(
      { error: "User not provisioned; please re-authenticate" },
      { status: 401 }
    );
  }

  if (error instanceof WalletRequiredError) {
    logRequestWarn(ctx.log, error, "WALLET_REQUIRED");
    return NextResponse.json(
      { error: "Wallet address required for payment operations" },
      { status: 403 }
    );
  }

  return null;
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "payments.intents", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    try {
      // Parse JSON body
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      // Validate with contract
      const input = paymentIntentOperation.input.parse(body);

      // Call facade with context
      if (!sessionUser) throw new Error("sessionUser required"); // Enforced by wrapper
      const result = await createPaymentIntentFacade(
        {
          sessionUser,
          ...input,
        },
        ctx
      );

      // Validate output and return
      return NextResponse.json(paymentIntentOperation.output.parse(result));
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error; // Unhandled - let wrapper catch
    }
  }
);
