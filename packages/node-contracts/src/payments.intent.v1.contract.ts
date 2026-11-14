// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/payments.intent.v1.contract`
 * Purpose: Contract for creating payment intents via HTTP API.
 * Scope: Defines request/response schemas for POST /api/v1/payments/intents; does not perform persistence or authentication.
 * Invariants: amountUsdCents must be between MIN_PAYMENT_CENTS and MAX_PAYMENT_CENTS; all outputs include on-chain transfer parameters.
 * Side-effects: none
 * Notes: Billing account and from address derived from session server-side; not provided in input.
 * Links: https://node-template.cognidao.org/knowledge/payments-usdc-verification-design
 * @public
 */

import { MAX_PAYMENT_CENTS, MIN_PAYMENT_CENTS } from "@cogni/node-core";
import { z } from "zod";

export const paymentIntentOperation = {
  id: "payments.intent.v1",
  summary: "Create payment intent",
  description:
    "Creates a payment intent with on-chain USDC transfer parameters for the authenticated user's wallet",
  input: z.object({
    amountUsdCents: z
      .number()
      .int()
      .min(
        MIN_PAYMENT_CENTS,
        `Minimum payment is $${MIN_PAYMENT_CENTS / 100} (${MIN_PAYMENT_CENTS} cents)`
      )
      .max(
        MAX_PAYMENT_CENTS,
        `Maximum payment is $${MAX_PAYMENT_CENTS / 100} (${MAX_PAYMENT_CENTS} cents)`
      ),
  }),
  output: z.object({
    attemptId: z.string().uuid(),
    chainId: z.number().int(),
    token: z.string(),
    to: z.string(),
    amountRaw: z.string(), // bigint as string for JSON serialization
    amountUsdCents: z.number().int(),
    expiresAt: z.string().datetime(),
  }),
} as const;

export type PaymentIntentInput = z.infer<typeof paymentIntentOperation.input>;
export type PaymentIntentOutput = z.infer<typeof paymentIntentOperation.output>;
