// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai-telemetry/langfuse.adapter`
 * Purpose: Langfuse SDK implementation of LangfusePort for trace correlation and observability.
 * Scope: Create Langfuse traces with OTel trace ID, update I/O, manage tool spans. Does NOT handle DB writes.
 * Invariants:
 *   - LANGFUSE_OTEL_TRACE_CORRELATION: Uses OTel traceId as Langfuse trace ID
 *   - LANGFUSE_NON_NULL_IO: Traces have non-null input/output
 *   - LANGFUSE_TERMINAL_ONCE_GUARD: Output set exactly once on terminal
 *   - flush() only if trace was created; never await on request path
 * Side-effects: IO (Langfuse API calls)
 * Notes: Per AI_SETUP_SPEC.md and OBSERVABILITY.md#langfuse-integration
 * Links: LangfusePort, ObservabilityGraphExecutorDecorator
 * @public
 */

import { Langfuse } from "langfuse";
import type {
  CreateTraceWithIOParams,
  InvocationStatus,
  LangfusePort,
  LangfuseSpanHandle,
  LlmErrorKind,
} from "@/ports";

export interface LangfuseAdapterConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  // Note: environment is read by Langfuse SDK from LANGFUSE_TRACING_ENVIRONMENT env var
}

// Re-export port types for convenience (canonical source is @/ports)
export type { CreateTraceWithIOParams, LangfuseSpanHandle };

/**
 * Langfuse SDK implementation of LangfusePort.
 * Optional adapter - only wired when LANGFUSE_SECRET_KEY is set.
 *
 * Per AI_SETUP_SPEC.md and OBSERVABILITY.md:
 * - Creates trace with id = OTel traceId (same ID for correlation)
 * - Supports input/output on traces for visibility
 * - Tool spans for tool execution tracking
 * - Flush only if trace created; never await on request path
 */
export class LangfuseAdapter implements LangfusePort {
  private readonly langfuse: Langfuse;
  private readonly activeTraces = new Set<string>();

  constructor(config: LangfuseAdapterConfig) {
    // Environment is read automatically by Langfuse SDK from LANGFUSE_TRACING_ENVIRONMENT env var
    this.langfuse = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
  }

  /**
   * Create a Langfuse trace with the OTel trace ID.
   * Uses traceId from OTel for correlation.
   *
   * @throws Error if trace creation fails (caller handles graceful degradation)
   */
  async createTrace(
    traceId: string,
    metadata: {
      requestId: string;
      model: string;
      promptHash: string;
    }
  ): Promise<string> {
    // No try/catch - let errors propagate to caller for graceful degradation
    // Caller wraps in try/catch and sets langfuseTraceId = undefined on failure
    this.langfuse.trace({
      id: traceId, // Use OTel traceId as Langfuse trace ID
      name: "llm-completion",
      metadata: {
        requestId: metadata.requestId,
        model: metadata.model,
        promptHash: metadata.promptHash,
      },
    });
    this.activeTraces.add(traceId);
    return traceId;
  }

  /**
   * Record generation metrics on the trace.
   * Per GENERATION_UNDER_EXISTING_TRACE: attaches to trace created by decorator.
   */
  recordGeneration(
    traceId: string,
    generation: {
      model: string;
      tokensIn?: number;
      tokensOut?: number;
      latencyMs: number;
      providerCostUsd?: number;
      status: InvocationStatus;
      errorCode?: LlmErrorKind;
      input?: unknown;
      output?: unknown;
    }
  ): void {
    try {
      // Build generation params conditionally to satisfy exact optional property types
      const generationParams: Parameters<typeof this.langfuse.generation>[0] = {
        traceId,
        name: "completion",
        model: generation.model,
        metadata: {
          latencyMs: generation.latencyMs,
          status: generation.status,
          errorCode: generation.errorCode,
        },
        level: generation.status === "error" ? "ERROR" : "DEFAULT",
      };

      // Include input/output for generation visibility
      if (generation.input !== undefined) {
        generationParams.input = generation.input;
      }
      if (generation.output !== undefined) {
        generationParams.output = generation.output;
      }

      // Only include usage if we have token data
      if (generation.tokensIn != null || generation.tokensOut != null) {
        generationParams.usage = {
          promptTokens: generation.tokensIn ?? null,
          completionTokens: generation.tokensOut ?? null,
        };
      }

      // Pass actual provider cost to Langfuse (overrides auto-calculated estimates)
      if (generation.providerCostUsd != null) {
        generationParams.costDetails = { total: generation.providerCostUsd };
      }

      // Only include statusMessage on error
      if (generation.status === "error") {
        generationParams.statusMessage = `Error: ${generation.errorCode ?? "unknown"}`;
      }

      this.langfuse.generation(generationParams);
    } catch (error) {
      // Graceful degradation - log and continue
      // biome-ignore lint/suspicious/noConsole: Langfuse errors should be visible
      console.error("[LangfuseAdapter] recordGeneration failed:", error);
    }
  }

  /**
   * Flush pending traces to Langfuse.
   * Only call if trace was created; never await on request path.
   */
  async flush(): Promise<void> {
    if (this.activeTraces.size === 0) {
      return;
    }

    try {
      await this.langfuse.flushAsync();
      this.activeTraces.clear();
    } catch (error) {
      // Graceful degradation - log and continue
      // biome-ignore lint/suspicious/noConsole: Langfuse errors should be visible
      console.error("[LangfuseAdapter] flush failed:", error);
      // Clear anyway to prevent memory leak
      this.activeTraces.clear();
    }
  }

  // =========================================================================
  // Extended methods for ObservabilityGraphExecutorDecorator
  // =========================================================================

  /**
   * Create a Langfuse trace with full I/O context.
   * Per LANGFUSE_NON_NULL_IO: input is set at creation; output on terminal.
   *
   * @param params - Trace creation params with input and metadata
   * @returns The trace ID (same as input traceId)
   */
  createTraceWithIO(params: CreateTraceWithIOParams): string {
    try {
      this.langfuse.trace({
        id: params.traceId,
        name: "graph-execution",
        input: params.input,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.userId ? { userId: params.userId } : {}),
        tags: params.tags,
        metadata: params.metadata,
      });
      this.activeTraces.add(params.traceId);
      return params.traceId;
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: Langfuse errors should be visible
      console.error("[LangfuseAdapter] createTraceWithIO failed:", error);
      throw error;
    }
  }

  /**
   * Update trace output on terminal resolution.
   * Per LANGFUSE_TERMINAL_ONCE_GUARD: called exactly once per trace.
   *
   * @param traceId - The trace to update
   * @param output - Scrubbed output content
   */
  updateTraceOutput(traceId: string, output: unknown): void {
    try {
      this.langfuse.trace({
        id: traceId,
        output,
      });
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: Langfuse errors should be visible
      console.error("[LangfuseAdapter] updateTraceOutput failed:", error);
    }
  }

  /**
   * Create a span for tool execution.
   * Per LANGFUSE_TOOL_SPANS_NOT_LOGS: tool spans visible in Langfuse, not logged.
   *
   * @param params - Span creation params
   * @returns Span handle with end() method
   */
  startSpan(params: {
    traceId: string;
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): LangfuseSpanHandle {
    const spanId = `span_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; // codeql[js/insecure-randomness] Telemetry span ID — not security-sensitive

    try {
      const span = this.langfuse.span({
        id: spanId,
        traceId: params.traceId,
        name: params.name,
        input: params.input,
        metadata: params.metadata,
      });

      return {
        spanId,
        end: (endParams) => {
          try {
            span.end({
              output: endParams.output,
              ...(endParams.level && { level: endParams.level }),
              ...(endParams.metadata && { metadata: endParams.metadata }),
            });
          } catch (error) {
            // biome-ignore lint/suspicious/noConsole: Langfuse errors should be visible
            console.error("[LangfuseAdapter] span.end failed:", error);
          }
        },
      };
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: Langfuse errors should be visible
      console.error("[LangfuseAdapter] startSpan failed:", error);
      // Return no-op handle on failure
      return {
        spanId,
        end: () => {},
      };
    }
  }
}
