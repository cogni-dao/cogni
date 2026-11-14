// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/payments.status.v1.contract`
 * Purpose: Contract for retrieving payment attempt status via HTTP API.
 * Scope: Defines request/response schemas for GET /api/v1/payments/attempts/:id; does not perform verification.
 * Invariants: Returns client-visible status (PENDING_VERIFICATION | CONFIRMED | FAILED); verification throttled server-side.
 * Side-effects: none
 * Notes: Status enum imported from /types (canonical source).
 * Links: https://node-template.cognidao.org/knowledge/payments-usdc-verification-design
 * @public
 */

import type { PaymentErrorCode, PaymentStatus } from "@cogni/node-core";
import { z } from "zod";

// Zod enum from canonical type
const paymentStatusEnum: z.ZodType<PaymentStatus> = z.enum([
  "PENDING_VERIFICATION",
  "CONFIRMED",
  "FAILED",
]);

const paymentErrorCodeEnum: z.ZodType<PaymentErrorCode> = z.enum([
  "SENDER_MISMATCH",
  "INVALID_TOKEN",
  "INVALID_RECIPIENT",
  "INSUFFICIENT_AMOUNT",
  "INSUFFICIENT_CONFIRMATIONS",
  "TX_REVERTED",
  "RECEIPT_NOT_FOUND",
  "INTENT_EXPIRED",
  "RPC_ERROR",
]);

export const paymentStatusOperation = {
  id: "payments.status.v1",
  summary: "Get payment attempt status",
  description:
    "Retrieves current status of payment attempt with throttled on-chain verification",
  input: z.object({}), // No input body - attemptId from URL params
  output: z.object({
    attemptId: z.string().uuid(),
    status: paymentStatusEnum,
    txHash: z.string().nullable(),
    amountUsdCents: z.number().int(),
    errorCode: paymentErrorCodeEnum.optional(),
    createdAt: z.string().datetime(),
  }),
} as const;

export type PaymentStatusInput = z.infer<typeof paymentStatusOperation.input>;
export type PaymentStatusOutput = z.infer<typeof paymentStatusOperation.output>;
