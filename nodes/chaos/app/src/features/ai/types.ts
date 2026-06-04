// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/types`
 * Purpose: Internal type definitions for AI feature streaming and tool lifecycle.
 * Scope: Re-exports AiEvent types from @cogni/node-core, re-exports tool types from @cogni/ai-tools. Feature-internal, NOT in shared/.
 * Invariants:
 *   - AiEvents are the ONLY output type from ai_runtime
 *   - toolCallId must be stable across start→result lifecycle
 *   - Route layer maps AiEvents to assistant-stream format (never runtime)
 *   - UsageReportEvent carries UsageFact for billing subscriber (never to UI)
 * Side-effects: none (types only)
 * Notes: Per AI_SETUP_SPEC.md P1 invariant AI_RUNTIME_EMITS_AIEVENTS, GRAPH_EXECUTION.md
 * Links: ai_runtime.ts, tool-runner.ts, AI_SETUP_SPEC.md, GRAPH_EXECUTION.md, @cogni/node-core.ts
 * @internal
 */

// Re-export tool types from @cogni/ai-tools package
export type {
  BoundTool,
  ToolContract,
  ToolErrorCode,
  ToolImplementation,
  ToolResult,
} from "@cogni/ai-tools";
// Re-export shared AI event types from types layer
export type {
  AiEvent,
  DoneEvent,
  TextDeltaEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  UsageReportEvent,
} from "@cogni/node-core";

// Import shared execution error code from ports layer
import type { AiExecutionErrorCode } from "@/ports";

/**
 * Stream final result - discriminated union for ok/error paths.
 * Per assistant-stream: route must emit FinishMessage with real usage/finishReason.
 * This type enables route to handle all terminal states without exceptions.
 *
 * Billing fields (model, providerCostUsd, litellmCallId) are included for
 * GraphExecutorAdapter to emit usage_report events. Per GRAPH_EXECUTION.md:
 * adapter emits usage_report → billing subscriber calls commitUsageFact().
 */
export type StreamFinalResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly usage: {
        readonly promptTokens: number;
        readonly completionTokens: number;
      };
      readonly finishReason: string;
      /** Resolved model ID for billing (from provider response) */
      readonly model?: string;
      /** Provider cost in USD for billing calculation */
      readonly providerCostUsd?: number;
      /** LiteLLM call ID for idempotent billing (usage_unit_id) */
      readonly litellmCallId?: string;
      /** Tool calls requested by LLM (present when finishReason === "tool_calls") */
      readonly toolCalls?: import("@/ports").LlmToolCall[];
    }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly error: AiExecutionErrorCode;
    };
