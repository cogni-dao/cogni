// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/payments.submit.v1.contract`
 * Purpose: Contract for submitting transaction hashes for payment verification via HTTP API.
 * Scope: Defines request/response schemas for POST /api/v1/payments/attempts/:id/submit; does not perform verification or settlement.
 * Invariants: txHash must be valid 32-byte hex string; idempotent on same hash for same attempt.
 * Side-effects: none
 * Notes: Status enum imported from /types (canonical source).
 * Links: https://node-template.cognidao.org/knowledge/payments-usdc-verification-design
 * @public
 */

import type { PaymentAttemptStatus, PaymentErrorCode } from "@cogni/node-core";
import { z } from "zod";

// Zod enums from canonical types
const paymentAttemptStatusEnum: z.ZodType<PaymentAttemptStatus> = z.enum([
  "CREATED_INTENT",
  "PENDING_UNVERIFIED",
  "CREDITED",
  "REJECTED",
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

export const paymentSubmitOperation = {
  id: "payments.submit.v1",
  summary: "Submit transaction hash for verification",
  description:
    "Binds transaction hash to payment attempt and initiates on-chain verification",
  input: z.object({
    txHash: z
      .string()
      .regex(
        /^0x[a-fA-F0-9]{64}$/,
        "Invalid transaction hash format (must be 0x + 64 hex chars)"
      ),
  }),
  output: z.object({
    attemptId: z.string().uuid(),
    status: paymentAttemptStatusEnum,
    txHash: z.string(),
    errorCode: paymentErrorCodeEnum.optional(),
    errorMessage: z.string().optional(),
  }),
} as const;

export type PaymentSubmitInput = z.infer<typeof paymentSubmitOperation.input>;
export type PaymentSubmitOutput = z.infer<typeof paymentSubmitOperation.output>;
