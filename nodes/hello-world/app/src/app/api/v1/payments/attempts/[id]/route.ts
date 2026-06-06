// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/payments/attempts/[id]`
 * Purpose: HTTP endpoint to retrieve payment attempt status with throttled verification.
 * Scope: Validates response with contract, enforces SIWE session, delegates to facade; does not perform verification directly.
 * Invariants: Ownership enforced via session billing account; verification throttled to 10-second intervals server-side.
 * Side-effects: IO (reads payment_attempts, may trigger verification and update status).
 * Notes: Returns 404 if attempt not found or not owned; polling endpoint for client to check status.
 * Links: docs/spec/payments-design.md
 * @public
 */

import { paymentStatusOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getPaymentStatusFacade } from "@/app/_facades/payments/attempts.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  AuthUserNotFoundError,
  PaymentNotFoundError,
} from "@/features/payments/errors";
import { logRequestWarn, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";

/**
 * Local error handler for payment status route.
 * Maps domain errors to HTTP responses; returns null for unhandled errors.
 */
function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
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

  return null;
}

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "payments.attempt_status",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    try {
      // Extract attemptId from URL params
      if (!context) throw new Error("context required for dynamic routes");
      const { id: attemptId } = await context.params;

      // Call facade with context
      if (!sessionUser) throw new Error("sessionUser required"); // Enforced by wrapper
      const result = await getPaymentStatusFacade(
        {
          sessionUser,
          attemptId,
        },
        ctx
      );

      // Validate output and return
      return NextResponse.json(paymentStatusOperation.output.parse(result));
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error; // Unhandled - let wrapper catch
    }
  }
);
