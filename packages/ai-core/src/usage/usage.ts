// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/usage/usage`
 * Purpose: Usage fact type for run-centric billing with idempotency.
 * Scope: Defines UsageFact and ExecutorType. Does NOT implement functions.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: This is the canonical definition; src/types re-exports
 *   - usageUnitId is REQUIRED for billing-authoritative executors (inproc/sandbox), enforced via Zod strict schema. Optional only for external/telemetry executors (hints schema).
 *   - runId + attempt + usageUnitId form the idempotency key (computed by billing.ts)
 *   - source identifies the adapter system (litellm, anthropic_sdk, etc.)
 *   - executorType is REQUIRED for executor-agnostic billing/history
 *   - billingAccountId / virtualKeyId may be attached upstream by a wrapper; schemas enforce them at billing ingestion
 * Side-effects: none (types only)
 * Links: billing.ts (computeIdempotencyKey, commitUsageFact), GRAPH_EXECUTION.md, LANGGRAPH_SERVER.md
 * @public
 */

import { z } from "zod";
import { SOURCE_SYSTEMS, type SourceSystem } from "../billing/source-system";
import type { GraphId } from "../graph/graph-id";

/**
 * Executor type for multi-runtime billing.
 * Per EXECUTOR_TYPE_REQUIRED invariant: all UsageFacts must specify executorType.
 */
export type ExecutorType =
  | "langgraph_server"
  | "claude_sdk"
  | "inproc"
  | "sandbox";

/**
 * Usage fact emitted by graph executors for billing ingestion.
 * Per GRAPH_EXECUTION.md: adapters emit usage_report events containing UsageFact.
 * Billing subscriber commits facts to ledger via commitUsageFact().
 *
 * Idempotency: (source_system, source_reference) where source_reference = runId/attempt/usageUnitId
 */
export interface UsageFact {
  // Required for idempotency key computation
  readonly runId: string;
  readonly attempt: number;
  /**
   * Adapter-provided stable ID for this usage unit.
   * For LiteLLM: captured from `x-litellm-call-id` response header.
   * USAGE_UNIT_IS_LITELLM_CALL_ID: `x-litellm-call-id === spend_logs.request_id`
   *   (manually verified 2026-02-07; automated test pending system test infra,
   *    see tests/stack/ai/litellm-call-id-mapping.stack.test.ts).
   * REQUIRED for billing-authoritative executors (inproc/sandbox) - enforced via Zod validation.
   * Optional for external executors (validated via hints schema).
   */
  readonly usageUnitId?: string;

  /** Source system for source_system column (NOT in idempotency key) */
  readonly source: SourceSystem;

  /**
   * Executor type for cross-executor billing (REQUIRED).
   * Per EXECUTOR_TYPE_REQUIRED invariant in LANGGRAPH_SERVER.md.
   */
  readonly executorType: ExecutorType;

  // Billing identity may be attached upstream by a wrapper before validation.
  readonly billingAccountId?: string;
  readonly virtualKeyId?: string;

  // Graph identifier for per-agent analytics (required)
  readonly graphId: GraphId;

  // Provider details
  readonly provider?: string;
  readonly model?: string;

  /**
   * Whether this call used a free-tier model, per the platform catalog's `is_free` flag.
   *
   * FREE_TIER_RESOLVED_BY_PRODUCER (bug.5266): resolved HERE, by the producer that still holds the
   * catalog model id — never re-derived downstream. `model` above is a human display name on the
   * callback path (`resolveDisplayName(entry.model_group)` → `"GPT-OSS 120B"`), so a catalog lookup
   * keyed on it silently misses and every free call reads as paid. `undefined` means "not resolved"
   * and is treated as paid (fail-to-charge, never fail-to-free).
   */
  readonly isFreeTier?: boolean;

  // Usage metrics
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;

  /** Raw payload for debugging (adapter can stash native IDs here) */
  readonly usageRaw?: Record<string, unknown>;
}

/**
 * Strict Zod schema for billing-authoritative executors (inproc, sandbox).
 * usageUnitId is REQUIRED. Validation failures = billing incomplete = run fails.
 */
export const UsageFactStrictSchema = z
  .object({
    // Required for idempotency
    runId: z.string().min(1, "runId required"),
    attempt: z.number().int().min(0, "attempt must be >= 0"),
    usageUnitId: z.string().min(1, "usageUnitId required (no fallback)"),

    // Required for billing context
    source: z.enum(SOURCE_SYSTEMS),
    executorType: z.enum(["inproc", "sandbox"]), // Only billing-authoritative types
    billingAccountId: z.string().min(1, "billingAccountId required"),
    virtualKeyId: z.string().min(1, "virtualKeyId required"),

    // Graph identifier for per-agent analytics (required, must be namespaced)
    graphId: z
      .string()
      .refine(
        (val) => val.includes(":"),
        "graphId must be namespaced (providerId:graphName)"
      ),

    // Optional provider details
    provider: z.string().optional(),
    model: z.string().optional(),

    // Optional usage metrics
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cacheReadTokens: z.number().int().min(0).optional(),
    cacheWriteTokens: z.number().int().min(0).optional(),
    costUsd: z.number().min(0).optional(),

    // Optional raw payload
    usageRaw: z.record(z.string(), z.unknown()).optional(),
  })
  .strict(); // Reject unknown fields

/**
 * Hints schema for external/telemetry executors (P1: langgraph_server, etc.).
 * usageUnitId is optional. Validation failures logged but don't block billing.
 */
export const UsageFactHintsSchema = z
  .object({
    runId: z.string().min(1),
    attempt: z.number().int().min(0),
    usageUnitId: z.string().optional(), // Telemetry hint, not authoritative

    source: z.enum(SOURCE_SYSTEMS),
    executorType: z.enum(["langgraph_server", "claude_sdk"]), // External types
    billingAccountId: z.string().min(1),
    virtualKeyId: z.string().min(1),

    graphId: z.string(), // Required for all executors

    provider: z.string().optional(),
    model: z.string().optional(),
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    costUsd: z.number().min(0).optional(),
  })
  .passthrough(); // Allow unknown fields from external systems
