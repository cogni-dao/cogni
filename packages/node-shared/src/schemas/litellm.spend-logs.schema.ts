// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/litellm.spend-logs.contract`
 * Purpose: Zod schema for LiteLLM /spend/logs API response.
 * Scope: External API contract validation. Does not implement business logic.
 * Invariants:
 * - request_id is required (becomes callId in port contract)
 * - startTime is required for timestamp
 * - model is required for telemetry
 * - prompt_tokens, completion_tokens, spend are required for usage data
 * - passthrough() allows unknown fields from LiteLLM without breaking
 * Side-effects: none
 * Links: packages/node-shared/src/schemas/litellm.spend-logs.schema.ts
 * @public
 */

import { z } from "zod";

/**
 * Coerce number to string for cost fields.
 * Ensures providerCostUsd is always string downstream.
 */
const costToString = z.preprocess(
  (val) => (typeof val === "number" ? String(val) : val),
  z.string()
);

/**
 * Date-only format YYYY-MM-DD for bucket aggregations.
 */
const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD format");

/**
 * ISO 8601 datetime with microseconds (e.g., "2025-12-08T17:06:47.809000Z").
 * LiteLLM returns 6-digit microseconds which strict z.datetime() rejects.
 */
const isoDatetimeWithMicros = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "Invalid datetime string",
  });

/**
 * Single log entry from LiteLLM /spend/logs API.
 * Uses passthrough() to tolerate additional fields LiteLLM may add.
 */
export const LiteLlmSpendLogSchema = z
  .object({
    /** LiteLLM request identifier - becomes callId in port contract */
    request_id: z.string().min(1, "request_id cannot be empty"),
    /** Timestamp of request start (ISO 8601 with microseconds) */
    startTime: isoDatetimeWithMicros,
    /** Model identifier from LiteLLM */
    model: z.string(),
    /** Input token count */
    prompt_tokens: z.number().int().nonnegative(),
    /** Output token count */
    completion_tokens: z.number().int().nonnegative(),
    /** Provider cost in USD - coerced to string */
    spend: costToString,
  })
  .passthrough();

/**
 * LiteLLM /spend/logs returns a raw array of log entries.
 * NOT wrapped in {logs: [...]} - this is validated at runtime.
 */
export const LiteLlmSpendLogsResponseSchema = z.array(LiteLlmSpendLogSchema);

/**
 * Single bucket entry from LiteLLM /spend/logs with group_by parameter.
 * Time fields are optional but at least one should be present.
 */
export const LiteLlmSpendBucketSchema = z
  .object({
    /** Bucket start time - ISO 8601 datetime with microseconds */
    startTime: isoDatetimeWithMicros.optional(),
    /** Bucket time - ISO 8601 datetime with microseconds */
    time: isoDatetimeWithMicros.optional(),
    /** Bucket date - YYYY-MM-DD only (no time component) */
    date: dateOnlySchema.optional(),
    /** Provider cost in USD - coerced to string */
    spend: costToString.optional(),
    cost: costToString.optional(),
    /** Token counts */
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    /** Request count */
    requests: z.number().int().nonnegative().optional(),
    count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/**
 * LiteLLM /spend/logs with group_by returns array of buckets.
 */
export const LiteLlmSpendBucketsResponseSchema = z.array(
  LiteLlmSpendBucketSchema
);

export type LiteLlmSpendLog = z.infer<typeof LiteLlmSpendLogSchema>;
export type LiteLlmSpendLogsResponse = z.infer<
  typeof LiteLlmSpendLogsResponseSchema
>;
export type LiteLlmSpendBucket = z.infer<typeof LiteLlmSpendBucketSchema>;
export type LiteLlmSpendBucketsResponse = z.infer<
  typeof LiteLlmSpendBucketsResponseSchema
>;
