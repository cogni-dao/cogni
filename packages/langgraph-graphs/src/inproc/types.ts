// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/types`
 * Purpose: Type definitions for InProc graph execution.
 * Scope: Package-owned types for runner interface. Does NOT import from src/.
 * Invariants:
 *   - PACKAGES_NO_SRC_IMPORTS: No imports from src/**
 *   - Single queue pattern: runner creates queue, passes emit to caller's factory
 *   - LANGCHAIN_ALIGNED: Graph types aligned with graphs/types.ts
 * Side-effects: none
 * Links: LANGGRAPH_AI.md
 * @public
 */

import type {
  AiEvent,
  AiExecutionErrorCode,
  AutoresearchRunSpec,
  ToolExecFn,
  ToolSpec,
} from "@cogni/ai-core";
import type { ToolContract } from "@cogni/ai-tools";
// Import shared graph types from graphs/types.ts (single source of truth)
import type {
  CreateReactAgentGraphOptions,
  InvokableGraph,
  MessageGraphInput,
  MessageGraphOutput,
} from "../graphs/types";
import type {
  CompletionFn,
  CompletionResult,
  ToolCall,
} from "../runtime/cogni/completion-adapter";
import type { Message } from "../runtime/core/message-converters";

// Re-export for convenience
export type { CompletionFn, CompletionResult, Message, ToolCall };

// ─────────────────────────────────────────────────────────────────────────────
// Graph Factory Types (aliased from graphs/types.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options passed to graph factory functions.
 * Alias to shared CreateReactAgentGraphOptions.
 */
export type CreateGraphOptions = CreateReactAgentGraphOptions;

/**
 * Minimal structural interface for compiled graphs.
 * Alias to shared InvokableGraph with message-based I/O.
 * Extended output allows `structuredResponse` when responseFormat is used.
 */
export type CompiledGraph = InvokableGraph<
  MessageGraphInput,
  MessageGraphOutput & { structuredResponse?: unknown }
>;

/**
 * Graph factory function signature.
 * Used by LangGraphInProcProvider to create graphs from catalog entries.
 *
 * Each graph type exports a factory matching this signature:
 * - createPoetGraph: Creates React agent for poet
 * - createResearchGraph: Creates research agent (Phase 5)
 */
export type CreateGraphFn = (opts: CreateGraphOptions) => CompiledGraph;

// Re-export canonical types from ai-core (per TOOL_EXEC_TYPES_IN_AI_CORE)
export type { ToolExecFn, ToolExecResult } from "@cogni/ai-core";

/**
 * Graph request (subset of GraphRunRequest, no src imports).
 */
export interface InProcGraphRequest {
  readonly runId: string;
  readonly messages: readonly Message[];
  readonly abortSignal?: AbortSignal;
  readonly traceId?: string;
  readonly ingressRequestId?: string;
  /**
   * RunnableConfig.configurable passed to graph.invoke().
   * Per UNIFIED_INVOKE_SIGNATURE: same shape for server and inproc.
   * - model: required for CogniCompletionAdapter (reads via configurable.model)
   * - toolIds: required for TOOLS_DENY_BY_DEFAULT
   * Provider is responsible for populating this from GraphRunConfig.
   */
  readonly configurable: {
    readonly model: string;
    readonly toolIds?: readonly string[];
    readonly autoresearch?: AutoresearchRunSpec;
  };
}

/**
 * Options for createInProcGraphRunner.
 * Runner creates queue internally, passes emit to createToolExecFn.
 * Generic TTool allows src/ to specify LlmToolDefinition while package defaults to unknown.
 */
export interface InProcRunnerOptions<TTool = unknown> {
  /** Graph factory from catalog - creates compiled graph with LLM and tools */
  readonly createGraph: CreateGraphFn;

  /** Per-LLM-call completion function (called N times in agentic loop) */
  readonly completionFn: CompletionFn<TTool>;

  /**
   * Factory that receives emit callback and returns ToolExecFn.
   * Caller wires toolRunner.emit to the emit callback.
   * This ensures tool events flow to the same queue as LLM events.
   */
  readonly createToolExecFn: (emit: (e: AiEvent) => void) => ToolExecFn;

  /** Tool contracts for LangChain tool wrapping */
  readonly toolContracts: ReadonlyArray<
    ToolContract<string, unknown, unknown, unknown>
  >;

  /**
   * MCP tool specs (JSON Schema based) to expose to the LLM.
   * These are wrapped as LangChain tools that delegate to toolExecFn,
   * flowing through the same toolRunner pipeline as native tools.
   */
  readonly mcpToolSpecs?: readonly ToolSpec[];

  /** Graph execution request */
  readonly request: InProcGraphRequest;

  /**
   * Optional structured output format passed to graph factory.
   * When set, graph uses LangGraph's responseFormat for parsed JSON output.
   */
  readonly responseFormat?: {
    readonly prompt?: string;
    readonly schema: unknown;
  };

  /**
   * Optional system prompt passed to graph factory.
   * Used by operator graphs where the prompt is catalog-driven, not hardcoded.
   */
  readonly systemPrompt?: string;
}

/**
 * Graph execution result.
 */
export interface GraphResult {
  readonly ok: boolean;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  };
  readonly finishReason?: string;
  readonly error?: AiExecutionErrorCode;
  /**
   * Error message for logging/debugging at adapter boundary.
   * Only populated on failure (ok: false). Not sent to clients.
   */
  readonly errorMessage?: string;
  /** Final assistant response content (for trace output) */
  readonly content?: string;
  /** Parsed structured output (when graph uses responseFormat) */
  readonly structuredOutput?: Record<string, unknown>;
}
