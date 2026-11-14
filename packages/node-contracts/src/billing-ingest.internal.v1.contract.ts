// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/billing-ingest.internal.v1.contract`
 * Purpose: Contract for LiteLLM generic_api callback → billing ingest endpoint.
 * Scope: Defines wire format for POST /api/internal/billing/ingest. Does not contain business logic.
 * Invariants:
 *   - Schema matches verified LiteLLM StandardLoggingPayload (spike 2026-02-13)
 *   - POST body is always a JSON array (batched payloads)
 *   - Bearer token auth required (BILLING_INGEST_TOKEN)
 *   - Token fields: prompt_tokens/completion_tokens/total_tokens (NOT input_tokens/output_tokens)
 *   - model_group = user-facing alias; model = full provider path
 * Side-effects: none
 * Links: /api/internal/billing/ingest route, https://node-template.cognidao.org/knowledge/billing-ingest-callback
 * @internal
 */

import { z } from "zod";

/**
 * Single entry from LiteLLM StandardLoggingPayload.
 * Only billing-relevant fields are validated; extra fields are passed through.
 *
 * Per billing-ingest-spec "Callback Payload Schema (Verified)":
 * - `id` = litellm_call_id (same as x-litellm-call-id header)
 * - `response_cost` = USD cost (0 for free models, >0 for paid)
 * - `end_user` = billingAccountId (empty string for header-based callers)
 * - `model_group` = LiteLLM alias (e.g. "gemini-2.5-flash")
 * - `model` = full provider path (e.g. "google/gemini-2.5-flash")
 */
export const StandardLoggingPayloadBillingSchema = z
  .object({
    id: z.string().min(1), // litellm_call_id
    call_type: z.string(),
    stream: z.boolean().nullable(),
    status: z.string(),
    response_cost: z.number(), // USD cost
    model: z.string(), // Full provider model path
    model_group: z.string(), // LiteLLM alias
    custom_llm_provider: z.string(),
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    total_tokens: z.number().int(),
    end_user: z.string(), // billingAccountId (may be empty — see End User Routing quirk)
    metadata: z
      .object({
        spend_logs_metadata: z
          .object({
            run_id: z.string(),
            node_id: z.string().optional(),
            graph_id: z.string().optional(),
            attempt: z.number().int().optional(),
          })
          .nullable(),
        user_api_key_end_user_id: z.string().nullable().optional(),
        requester_custom_headers: z.record(z.string(), z.string()).optional(),
      })
      .passthrough(), // Allow extra LiteLLM internal fields
  })
  .passthrough(); // Allow extra StandardLoggingPayload fields we don't need

/**
 * POST body: always a JSON array (LiteLLM batches callbacks).
 */
export const BillingIngestBodySchema = z.array(
  StandardLoggingPayloadBillingSchema
);

export type StandardLoggingPayloadBilling = z.infer<
  typeof StandardLoggingPayloadBillingSchema
>;
export type BillingIngestBody = z.infer<typeof BillingIngestBodySchema>;

/**
 * Response shape for billing ingest endpoint.
 * No "duplicates" counter — commitUsageFact handles idempotency internally.
 */
export const BillingIngestResponseSchema = z.object({
  processed: z.number().int(),
  skipped: z.number().int(),
});

export type BillingIngestResponse = z.infer<typeof BillingIngestResponseSchema>;
