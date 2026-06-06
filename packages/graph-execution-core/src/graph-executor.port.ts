// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-core/graph-executor`
 * Purpose: Port interface for unified graph execution.
 * Scope: Defines GraphExecutorPort contract for all graph executors. Does not implement execution logic or carry billing/tracing/delivery concerns.
 * Invariants:
 *   - UNIFIED_GRAPH_EXECUTOR: All graph execution flows through this port
 *   - GRAPH_FINALIZATION_ONCE: Exactly one done event and final resolution per run
 *   - GRAPH_ID_NAMESPACED: graphId format is ${providerId}:${graphName}
 *   - NO_BILLING_LEAKAGE: No billing types on request or context
 *   - NO_TRACING_LEAKAGE: No traceId — flows via OTel context propagation
 * Side-effects: none (interface only)
 * Links: docs/spec/unified-graph-launch.md, docs/spec/graph-execution.md
 * @public
 */

import type {
  AiEvent,
  AiExecutionErrorCode,
  AutoresearchRunSpec,
  GraphId,
  Message,
  ModelRef,
} from "@cogni/ai-core";

import type { ExecutionContext } from "./execution-context";

/**
 * Pure business input for a graph run.
 * No billing, no tracing, no delivery-layer concerns.
 */
export interface GraphRunRequest {
  /** Unique run ID for this graph execution (caller-provided) */
  readonly runId: string;
  /**
   * Fully-qualified graph ID for routing (e.g., "langgraph:poet").
   * Per GRAPH_ID_NAMESPACED: format is ${providerId}:${graphName}
   */
  readonly graphId: GraphId;
  /** Input messages */
  readonly messages: Message[];
  /** Fully-resolved model reference (provider + model + optional connection) */
  readonly modelRef: ModelRef;
  /**
   * Thread key for multi-turn conversation state.
   * Semantics are adapter-specific:
   * - InProc: ignored (no thread state)
   * - LangGraph Server: required (derive threadId, send only new input)
   */
  readonly stateKey?: string;
  /**
   * Per-run tool allowlist from GraphRunConfig.
   * Tools not in this list receive policy_denied error.
   * If undefined, falls back to catalog default.
   */
  readonly toolIds?: readonly string[];
  /**
   * Optional structured output format for the graph.
   * When set, the graph returns parsed JSON in `GraphFinal.structuredOutput`.
   */
  readonly responseFormat?: {
    readonly prompt?: string;
    readonly schema: unknown;
  };
  /**
   * Drift-resistant autoresearch contract.
   * Pure business input: objective, memory policy, reward metric, fanout budget,
   * and selection policy. Billing/tracing remain outside this request.
   */
  readonly autoresearch?: AutoresearchRunSpec;
}

/**
 * Final result after graph execution completes.
 */
export interface GraphFinal {
  /** True if graph completed successfully */
  readonly ok: boolean;
  /** Run ID for correlation */
  readonly runId: string;
  /** Request ID for correlation (observability) */
  readonly requestId: string;
  /** Token usage totals (if successful) */
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  };
  /** How the graph finished */
  readonly finishReason?: string;
  /** Error type if not ok */
  readonly error?: AiExecutionErrorCode;
  /** Final assistant response content (for trace output) */
  readonly content?: string;
  /** Parsed structured output (when graph uses responseFormat) */
  readonly structuredOutput?: Record<string, unknown>;
}

/**
 * Result of starting a graph execution.
 * Non-async: returns stream handle immediately; execution happens on consumption.
 */
export interface GraphRunResult {
  /** Stream of AI events for real-time processing */
  readonly stream: AsyncIterable<AiEvent>;
  /** Promise resolving when graph completes */
  readonly final: Promise<GraphFinal>;
}

/**
 * Port interface for graph execution.
 * Per UNIFIED_GRAPH_EXECUTOR invariant: all graphs flow through this interface.
 *
 * Non-async method: returns stream handle immediately.
 * Actual execution happens as the stream is consumed.
 *
 * **Caller MUST consume `stream` to completion.** Billing side-effects
 * (via decorators) are triggered by stream iteration.
 *
 * @param req - Pure business input: messages, model, graphId
 * @param ctx - Per-run cross-cutting metadata: actor, session, abort signal
 */
export interface GraphExecutorPort {
  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult;
}
