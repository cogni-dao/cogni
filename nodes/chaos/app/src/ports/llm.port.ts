// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/llm.port`
 * Purpose: LLM service abstraction for hexagonal architecture.
 * Scope: Future-ready interface that won't require refactoring when adding streaming/metadata. Does not handle authentication or rate limiting.
 * Invariants: Only depends on core domain types, no infrastructure concerns
 * Side-effects: none (interface only)
 * Notes: Supports optional parameters, returns structured response with metadata
 * Links: Implemented by adapters, used by features
 * @public
 */

import type { AiExecutionErrorCode } from "@cogni/ai-core";
import type { Message } from "@cogni/node-core";

// Re-export types used in port interfaces
export type { AiExecutionErrorCode } from "@cogni/ai-core";
// Re-export LLM error types for adapters (adapters can only import from ports)
export {
  classifyLlmErrorFromStatus,
  isLlmError,
  LlmError,
  type LlmErrorKind,
  normalizeErrorToExecutionCode,
} from "@cogni/ai-core";
export type { Message } from "@cogni/node-core";

// ─────────────────────────────────────────────────────────────────────────────
// Tool Types (OpenAI-compatible format for LiteLLM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON Schema object for tool parameters.
 * Simplified representation - full JSON Schema spec not needed for MVP.
 */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/**
 * Tool definition in OpenAI function-calling format.
 * Used to declare tools to the LLM.
 */
export interface LlmToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: JsonSchemaObject;
  };
}

/**
 * Completed tool call from LLM response.
 * Represents a fully-formed tool invocation request.
 */
export interface LlmToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string; // JSON string, needs parsing
  };
}

/**
 * Incremental tool call delta from SSE stream.
 * Fragments are accumulated by index until complete.
 */
export interface LlmToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string; // Partial JSON fragment
  };
}

/**
 * Tool choice specification for LLM request.
 * - "auto": LLM decides whether to use tools
 * - "none": Disable tool use
 * - "required": Force tool use
 * - {name: string}: Force specific tool
 */
export type LlmToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly function: { readonly name: string } };

/**
 * Caller info for direct LLM calls (no graph execution).
 * Per AI_SETUP_SPEC.md P1 invariant GRAPH_CALLER_TYPE_REQUIRED:
 * DO NOT add graphRunId as optional field here.
 * Use GraphLlmCaller for graph executions.
 */
export interface LlmCaller {
  billingAccountId: string;
  virtualKeyId: string;
  /** Request correlation ID - for LiteLLM metadata propagation */
  requestId: string;
  /** OTel trace ID - for LiteLLM metadata propagation */
  traceId: string;
  /** Session ID for Langfuse session grouping (<=200 chars) */
  sessionId?: string;
  /** Stable user ID for Langfuse user grouping (not email - internal ID) */
  userId?: string;
  /** Per-user opt-out: true => Langfuse receives hashes only, no readable content */
  maskContent?: boolean;
}

/**
 * Caller info for LLM calls within a graph execution.
 * Extends LlmCaller with REQUIRED graph metadata (not optional).
 * Per AI_SETUP_SPEC.md:
 * - graphRunId: UUID per graph execution, groups multiple LLM calls in one request
 * - graphName: Graph module constant (e.g., "review_graph")
 * - graphVersion: Git SHA at build time (for reproducibility)
 */
export interface GraphLlmCaller extends LlmCaller {
  /** UUID identifying this graph execution; same across all LLM calls in graph */
  graphRunId: string;
  /** Graph module constant (e.g., "review_graph"); enables correlation in ai_invocation_summaries */
  graphName: string;
  /** Git SHA at build time; enables reproducibility across deployments */
  graphVersion: string;
}

export interface CompletionStreamParams {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  caller: LlmCaller;
  abortSignal?: AbortSignal;
  /** Tool definitions for function calling (readonly - never mutated) */
  tools?: readonly LlmToolDefinition[];
  /** Tool choice strategy */
  toolChoice?: LlmToolChoice;
  /** Billing correlation metadata forwarded to LiteLLM as x-litellm-spend-logs-metadata header */
  spendLogsMetadata?: { run_id: string; graph_id: string; node_id?: string };
}

export type ChatDeltaEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_delta"; delta: LlmToolCallDelta }
  | { type: "error"; error: string }
  | { type: "done" };

// ─────────────────────────────────────────────────────────────────────────────
// Completion Unit Result (for graph execution)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated union for completion unit final result.
 * Used by graph runners to handle LLM call outcomes.
 * - ok: true → success with usage/finishReason/toolCalls
 * - ok: false → error with stable error code
 */
export type CompletionFinalResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly usage: {
        readonly promptTokens: number;
        readonly completionTokens: number;
      };
      readonly finishReason: string;
      /** Resolved model ID for billing */
      readonly model?: string;
      /** Provider cost in USD */
      readonly providerCostUsd?: number;
      /** LiteLLM call ID for idempotent billing */
      readonly litellmCallId?: string;
      /** Tool calls requested by LLM (when finishReason === "tool_calls") */
      readonly toolCalls?: LlmToolCall[];
      /** Assistant response content (for trace output) */
      readonly content?: string;
    }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly error: AiExecutionErrorCode;
    };

/**
 * Result type for LLM completion operations.
 * Extended with reproducibility keys per AI_SETUP_SPEC.md.
 */
export interface LlmCompletionResult {
  message: Message;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | string;
  /** Accumulated tool calls from stream (when finish_reason == "tool_calls") */
  toolCalls?: LlmToolCall[];
  providerMeta?: Record<string, unknown>;
  providerCostUsd?: number;
  /** LiteLLM call ID for forensic correlation (x-litellm-call-id header or response id) */
  litellmCallId?: string;
  /** SHA-256 hash of canonical outbound payload (model/messages/temperature/tools) for reproducibility */
  promptHash?: string;
  /** Resolved provider name (e.g., "openai", "anthropic") from LiteLLM response */
  resolvedProvider?: string;
  /** Resolved model ID (e.g., "gpt-4o-2024-11-20") from LiteLLM response */
  resolvedModel?: string;
  /** Human-readable display name (e.g., "Claude Sonnet 4.5") from the adapter's source of truth */
  resolvedDisplayName?: string;
}

export interface LlmService {
  completion(params: {
    messages: Message[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    caller: LlmCaller;
    /** Billing correlation metadata forwarded to LiteLLM as x-litellm-spend-logs-metadata header */
    spendLogsMetadata?: { run_id: string; graph_id: string; node_id?: string };
  }): Promise<LlmCompletionResult>;

  completionStream(params: CompletionStreamParams): Promise<{
    stream: AsyncIterable<ChatDeltaEvent>;
    final: Promise<LlmCompletionResult>;
  }>;
}
