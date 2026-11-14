// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/ai.activity.v1.contract`
 * Purpose: Contract for fetching AI usage activity (charts + logs).
 * Scope: Defines input/output for activity dashboard. Does not implement logic.
 * Invariants:
 * - Time is UTC ISO strings.
 * - Range is [from, to) (inclusive start, exclusive end).
 * - Chart buckets are zero-filled for the requested range.
 * - Money is decimal string to avoid float precision issues.
 * - Cursor is opaque string.
 * - Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH: all data sourced from charge_receipts + llm_charge_details.
 * Side-effects: none
 * Links: [activity.server.ts](../../app/_facades/ai/activity.server.ts)
 * @public
 */

import { z } from "zod";

/**
 * Allowed step values for time bucketing.
 * Server derives optimal step from range if not provided.
 * Max granularity is 1d (no weekly buckets - too coarse for useful analysis).
 */
export const ActivityStepSchema = z.enum(["5m", "15m", "1h", "6h", "1d"]);
export type ActivityStep = z.infer<typeof ActivityStepSchema>;

/**
 * Step durations in milliseconds for epoch-based bucketing.
 */
export const STEP_MS: Record<ActivityStep, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

/**
 * Maximum allowed range (in ms) for each step to enforce maxPoints cap (~48 buckets).
 */
export const MAX_RANGE_FOR_STEP: Record<ActivityStep, number> = {
  "5m": 4 * 60 * 60 * 1000, // 4 hours (48 buckets)
  "15m": 12 * 60 * 60 * 1000, // 12 hours (48 buckets)
  "1h": 2 * 24 * 60 * 60 * 1000, // 2 days (48 buckets)
  "6h": 12 * 24 * 60 * 60 * 1000, // 12 days (48 buckets)
  "1d": 90 * 24 * 60 * 60 * 1000, // 90 days (max range, 90 buckets)
};

/**
 * Maximum overall range allowed (90 days).
 */
export const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Time range presets for rolling windows.
 * Server derives from/to using server time for consistent results.
 */
export const TimeRangeSchema = z.enum(["1d", "1w", "1m"]);
export type TimeRange = z.infer<typeof TimeRangeSchema>;

/**
 * Grouping dimension for chart breakdown.
 * - "model": group by LLM model name (e.g. "claude-opus-4.6", "deepseek-v3")
 * - "graphId": group by agent/graph ID (e.g. "langgraph:poet", "raw-completion")
 */
export const ActivityGroupBySchema = z.enum(["model", "graphId"]);
export type ActivityGroupBy = z.infer<typeof ActivityGroupBySchema>;

/**
 * Scope determines which billing account to query.
 * - "user": authenticated user's billing account (default)
 * - "system": system tenant billing account (Cogni DAO)
 */
export const ActivityScopeSchema = z.enum(["user", "system"]);
export type ActivityScope = z.infer<typeof ActivityScopeSchema>;

export const aiActivityOperation = {
  id: "ai.activity.v1",
  summary: "Fetch AI activity statistics and logs",
  description:
    "Returns usage statistics (spend, tokens, requests) grouped by time, and a paginated list of usage logs. Server derives optimal bucket step from range size.",
  input: z
    .object({
      scope: ActivityScopeSchema.optional().describe(
        "Billing scope: 'user' (default) or 'system' (Cogni DAO treasury)"
      ),
      range: TimeRangeSchema.optional().describe(
        "Preset time range (1d/1w/1m). Server derives from/to using server time."
      ),
      from: z
        .string()
        .datetime()
        .optional()
        .describe(
          "Start time (inclusive, UTC ISO). Use with 'to' for custom range."
        ),
      to: z
        .string()
        .datetime()
        .optional()
        .describe(
          "End time (exclusive, UTC ISO). Use with 'from' for custom range."
        ),
      step: ActivityStepSchema.optional().describe(
        "Bucket granularity (server-derived if omitted)"
      ),
      groupBy: ActivityGroupBySchema.optional().describe(
        "Breakdown dimension for chart series (model or graphId). Omit for aggregate-only."
      ),
      cursor: z.string().optional().describe("Opaque cursor for pagination"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(20)
        .describe("Max logs to return"),
    })
    .refine((data) => data.range || (data.from && data.to), {
      message: "Either 'range' or both 'from' and 'to' must be provided",
    }),
  output: z.object({
    effectiveStep: ActivityStepSchema.describe(
      "Actual step used (server-derived or validated)"
    ),
    chartSeries: z.array(
      z.object({
        bucketStart: z.string().datetime(),
        spend: z.string().describe("Decimal string USD"),
        tokens: z.number().int().nonnegative(),
        requests: z.number().int().nonnegative(),
      })
    ),
    /** Per-group breakdown keyed by group name. Only present when groupBy is specified. */
    groupedSeries: z
      .array(
        z.object({
          group: z.string().describe("Group key (model name or graphId)"),
          buckets: z.array(
            z.object({
              bucketStart: z.string().datetime(),
              spend: z.number().nonnegative(),
              tokens: z.number().int().nonnegative(),
              requests: z.number().int().nonnegative(),
            })
          ),
        })
      )
      .optional(),
    totals: z.object({
      spend: z.object({
        total: z.string().describe("Decimal string USD"),
        avgDay: z.string().describe("Total / calendar days"),
        pastRange: z.string().describe("Total for previous equivalent range"),
      }),
      tokens: z.object({
        total: z.number().int(),
        avgDay: z.number(),
        pastRange: z.number().int(),
      }),
      requests: z.object({
        total: z.number().int(),
        avgDay: z.number(),
        pastRange: z.number().int(),
      }),
    }),
    rows: z.array(
      z.object({
        id: z.string(),
        timestamp: z.string().datetime(),
        provider: z.string(),
        model: z.string(),
        graphId: z.string(),
        tokensIn: z.number().int(),
        tokensOut: z.number().int(),
        cost: z.string().describe("Decimal string USD"),
        speed: z.number().describe("Tokens per second"),
        finish: z.string().optional(),
      })
    ),
    nextCursor: z.string().nullable(),
  }),
} as const;
