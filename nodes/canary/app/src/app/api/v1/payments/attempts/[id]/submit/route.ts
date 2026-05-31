// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/payments/attempts/[id]/submit`
 * Purpose: HTTP endpoint to submit transaction hash for payment verification.
 * Scope: Validates request/response with contract, enforces SIWE session, delegates to facade; does not perform verification or settlement directly.
 * Invariants: Ownership enforced via session billing account; idempotent on same txHash for same attempt.
 * Side-effects: IO (binds txHash, updates payment_attempts, logs payment_events, initiates verification).
 * Notes: Returns 404 if attempt not found or not owned; 409 if txHash already bound to different attempt.
 * Links: docs/spec/payments-design.md
 * @public
 */

import { paymentSubmitOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { submitPaymentTxHashFacade } from "@/app/_facades/payments/attempts.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  AuthUserNotFoundError,
  PaymentNotFoundError,
} from "@/features/payments/errors";
import { isTxHashAlreadyBoundPortError } from "@/ports";
import { logRequestWarn, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";

/**
 * Local error handler for payment submit route.
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

  // Payment not found errors
  if (error instanceof PaymentNotFoundError) {
    logRequestWarn(ctx.log, error, "PAYMENT_NOT_FOUND");
    return NextResponse.json(
      { error: "Payment attempt not found or not owned by user" },
      { status: 404 }
    );
  }

  // TxHash conflict errors (duplicate txHash on different attempt)
  if (isTxHashAlreadyBoundPortError(error)) {
    logRequestWarn(ctx.log, error, "TXHASH_CONFLICT");
    return NextResponse.json(
      {
        error: "Transaction hash already used by another payment attempt",
      },
      { status: 409 }
    );
  }

  return null;
}

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "payments.attempt_submit",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    try {
      // Extract attemptId from URL params
      if (!context) throw new Error("context required for dynamic routes");
      const { id: attemptId } = await context.params;

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
      const input = paymentSubmitOperation.input.parse(body);

      // Call facade with context
      if (!sessionUser) throw new Error("sessionUser required"); // Enforced by wrapper
      const result = await submitPaymentTxHashFacade(
        {
          sessionUser,
          attemptId,
          ...input,
        },
        ctx
      );

      // Validate output and return
      return NextResponse.json(paymentSubmitOperation.output.parse(result));
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error; // Unhandled - let wrapper catch
    }
  }
);
