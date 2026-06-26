// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/decorators/observability-executor`
 * Purpose: Decorator that wraps GraphExecutorPort with Langfuse observability.
 * Scope: Creates root trace with input, updates output on terminal, handles all 4 terminal states. Does not execute graphs directly (delegates to inner).
 * Invariants:
 *   - LANGFUSE_OTEL_TRACE_CORRELATION: Uses ctx.traceId (OTel) as Langfuse trace ID
 *   - LANGFUSE_TERMINAL_ONCE_GUARD: Exactly one terminal outcome per trace
 *   - LANGFUSE_NON_NULL_IO: Non-null input at start, non-null output on terminal
 *   - LANGFUSE_SCRUB_BEFORE_SEND: All content scrubbed before Langfuse
 *   - ERROR_NORMALIZATION_ONCE: Catch block uses normalizeErrorToExecutionCode()
 *   - PURE_LIBRARY: no env vars, no process lifecycle, no @opentelemetry/api dep
 * Side-effects: IO (Langfuse API calls via adapter)
 * Links: OBSERVABILITY.md#langfuse-integration, ERROR_HANDLING_ARCHITECTURE.md
 * @public
 */

import { type AiEvent, normalizeErrorToExecutionCode } from "@cogni/ai-core";
import type {
  ExecutionContext,
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
} from "@cogni/graph-execution-core";
import {
  applyUserMaskingPreference,
  EVENT_NAMES,
  isValidOtelTraceId,
  scrubTraceInput,
  scrubTraceOutput,
  truncateSessionId,
} from "@cogni/node-shared";

import type { LoggerPort } from "../ports/logger.port";
import type { GetTraceIdFn, TracingPort } from "../ports/tracing.port";

const DEFAULT_TRACE_ID = "00000000000000000000000000000000";

/**
 * Terminal state tracking for once-guard.
 */
interface TerminalState {
  resolved: boolean;
  outcome?: "success" | "error" | "aborted" | "finalization_lost";
  finalizationTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Configuration for the observability decorator.
 */
export interface ObservabilityDecoratorConfig {
  /** Finalization lost timeout in ms (default: 15000) */
  finalizationTimeoutMs?: number;
  /** Callback to retrieve the current OTel trace ID. Injected to avoid @opentelemetry/api dep. */
  getTraceId?: GetTraceIdFn;
  /**
   * Node identity (= repo-spec `node_id`) stamped onto every trace as a tag + metadata field.
   * Per LANGFUSE_NODE_ATTRIBUTION (OBSERVABILITY.md): makes traces filterable to a single node so a
   * node developer can read only their traces. Resolved app-side (e.g. `container.nodeId`) and injected
   * here — the PURE_LIBRARY package never reads repo-spec/env itself. Optional for non-breaking rollout;
   * a warn-once fires when absent so a mis-wired node is detectable.
   */
  nodeId?: string;
}

/** Process-local guard so the missing-nodeId warning fires once, not per run. */
let warnedMissingNodeId = false;

/**
 * Decorator that wraps GraphExecutorPort with Langfuse observability.
 *
 * Per OBSERVABILITY.md#langfuse-integration:
 * - Creates trace with scrubbed input at start
 * - Updates trace with scrubbed output on terminal
 * - Handles all 4 terminal states: success, error, aborted, finalization_lost
 * - Once-guard ensures exactly one terminal outcome per trace
 *
 * Note: Discovery (listAgents) is in AgentCatalogPort, not here.
 */
export class ObservabilityGraphExecutorDecorator implements GraphExecutorPort {
  private readonly finalizationTimeoutMs: number;
  private readonly getTraceId: GetTraceIdFn;
  private readonly nodeId: string | undefined;

  constructor(
    private readonly inner: GraphExecutorPort,
    private readonly tracing: TracingPort | undefined,
    config: ObservabilityDecoratorConfig,
    private readonly log: LoggerPort,
    private readonly billingAccountId: string
  ) {
    this.finalizationTimeoutMs = config.finalizationTimeoutMs ?? 15_000;
    this.getTraceId = config.getTraceId ?? (() => DEFAULT_TRACE_ID);
    this.nodeId = config.nodeId;

    // Per LANGFUSE_NODE_ATTRIBUTION: a node with no nodeId emits node-less traces with no error,
    // silently defeating per-node trace isolation. Warn once per process so a mis-wired node is visible.
    if (!this.nodeId && !warnedMissingNodeId) {
      warnedMissingNodeId = true;
      this.log.warn(
        {},
        "Langfuse trace nodeId not wired — traces will not be node-attributable (LANGFUSE_NODE_ATTRIBUTION)"
      );
    }
  }

  /**
   * Execute graph with Langfuse observability.
   * Wraps inner executor, creates trace, handles terminal state.
   */
  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const { runId, graphId, messages, modelRef } = req;
    const model = modelRef.modelId;
    const requestId = ctx?.requestId ?? req.runId;
    const maskContent = ctx?.maskContent ?? false;

    // Extract providerId from graphId (e.g., "langgraph:poet" → "langgraph")
    const providerId = graphId.split(":")[0] ?? "unknown";

    // Validate traceId - use OTel if valid, otherwise generate with correlation
    const otelTraceId = this.getTraceId();
    let traceId: string;
    let otelTraceIdForMetadata: string | undefined;

    if (isValidOtelTraceId(otelTraceId)) {
      traceId = otelTraceId;
    } else {
      // Generate Langfuse ID, store original for correlation
      traceId = crypto.randomUUID().replace(/-/g, "");
      otelTraceIdForMetadata = otelTraceId;
      this.log.warn(
        { originalTraceId: otelTraceId, generatedTraceId: traceId },
        "Invalid OTel traceId format; generated Langfuse ID"
      );
    }

    // Scrub input for Langfuse
    const scrubbedInput = scrubTraceInput(messages);
    const finalInput = applyUserMaskingPreference(scrubbedInput, maskContent);

    // Create Langfuse trace
    let langfuseTraceId: string | undefined;
    if (this.tracing) {
      try {
        const sessionId = truncateSessionId(ctx?.sessionId);
        langfuseTraceId = this.tracing.createTraceWithIO({
          traceId,
          ...(sessionId && { sessionId }),
          ...(ctx?.actorUserId && { userId: ctx.actorUserId }),
          input: finalInput,
          // Per LANGFUSE_NODE_ATTRIBUTION: nodeId is the per-node read filter (the dev-read proxy
          // AND-s on this tag); also in metadata for correlation. Omitted when unwired (warn-once above).
          tags: this.nodeId
            ? [providerId, graphId, this.nodeId]
            : [providerId, graphId],
          metadata: {
            runId,
            reqId: requestId,
            graphId,
            providerId,
            model,
            billingAccountId: this.billingAccountId,
            ...(this.nodeId && { nodeId: this.nodeId }),
            ...(otelTraceIdForMetadata && {
              otelTraceId: otelTraceIdForMetadata,
            }),
          },
        });

        // Log trace created (per OBSERVABILITY.md: 2-4 events per request)
        this.log.info(
          {
            reqId: requestId,
            traceId,
            langfuseTraceId,
            graphId,
            event: EVENT_NAMES.LANGFUSE_TRACE_CREATED,
          },
          EVENT_NAMES.LANGFUSE_TRACE_CREATED
        );
      } catch (error) {
        this.log.error(
          { err: error, runId, graphId },
          "Failed to create Langfuse trace"
        );
      }
    }

    // Terminal state management with once-guard
    const terminal: TerminalState = { resolved: false };
    let assistantFinalContent: string | null = null;
    let streamEnded = false;

    /**
     * Resolve terminal outcome exactly once.
     * Per LANGFUSE_TERMINAL_ONCE_GUARD: first resolution wins.
     * Per FINAL_CONTENT_OVER_STREAM: prefer final.content over stream-captured content.
     */
    const resolveTerminal = async (
      outcome: NonNullable<TerminalState["outcome"]>,
      details: {
        error?: string;
        finishReason?: string;
        usage?: { promptTokens: number; completionTokens: number };
        content?: string;
      }
    ): Promise<void> => {
      // Once-guard
      if (terminal.resolved) return;
      terminal.resolved = true;
      terminal.outcome = outcome;

      // Clear finalization timer if set
      if (terminal.finalizationTimer) {
        clearTimeout(terminal.finalizationTimer);
        delete terminal.finalizationTimer;
      }

      // Prefer final.content (deterministic) over stream-captured (unreliable)
      const outputContent = details.content ?? assistantFinalContent;

      // Scrub output for Langfuse
      const scrubbedOutput = scrubTraceOutput(outputContent, {
        status: outcome,
        ...(details.finishReason && { finishReason: details.finishReason }),
        ...(details.error && { errorCode: details.error }),
        ...(details.usage && { usage: details.usage }),
      });
      const finalOutput = applyUserMaskingPreference(
        scrubbedOutput,
        maskContent
      );

      // Update Langfuse trace output
      if (this.tracing && langfuseTraceId) {
        this.tracing.updateTraceOutput(traceId, finalOutput);

        // Flush in background
        this.tracing
          .flush()
          .catch((err) =>
            this.log.warn({ err }, "Langfuse flush failed on terminal")
          );
      }

      // Log trace completed
      this.log.info(
        {
          reqId: requestId,
          traceId,
          langfuseTraceId,
          outcome,
          event: EVENT_NAMES.LANGFUSE_TRACE_COMPLETED,
        },
        EVENT_NAMES.LANGFUSE_TRACE_COMPLETED
      );
    };

    // Delegate to inner executor
    const result = this.inner.runGraph(req, ctx);

    // Wrap stream to intercept events
    const wrappedStream = this.wrapStream(result.stream, {
      onAssistantFinal: (content) => {
        assistantFinalContent = content;
      },
      onDone: () => {
        streamEnded = true;
        if (assistantFinalContent === null && !terminal.resolved) {
          // Done without assistant_final - start finalization_lost timer
          terminal.finalizationTimer = setTimeout(() => {
            void resolveTerminal("finalization_lost", {});
          }, this.finalizationTimeoutMs);
        }
      },
      onError: (code) => {
        void resolveTerminal("error", { error: code });
      },
    });

    // Handle stream ending without done event (edge case)
    const handleStreamEnd = (): void => {
      if (!streamEnded && !terminal.resolved) {
        // Stream ended without done - start finalization timer
        terminal.finalizationTimer = setTimeout(() => {
          void resolveTerminal("finalization_lost", {});
        }, this.finalizationTimeoutMs);
      }
    };

    // Wrap final promise
    const wrappedFinal = result.final
      .then(async (final: GraphFinal) => {
        handleStreamEnd();
        if (final.ok) {
          await resolveTerminal("success", {
            ...(final.finishReason && { finishReason: final.finishReason }),
            ...(final.usage && { usage: final.usage }),
            ...(final.content && { content: final.content }),
          });
        } else {
          await resolveTerminal("error", {
            ...(final.error && { error: final.error }),
          });
        }
        return final;
      })
      .catch(async (err: unknown) => {
        handleStreamEnd();
        // Normalize error using typed LlmError when available (e.g., rate_limit, timeout)
        // Per ERROR_NORMALIZATION_ONCE: this is the last common point before the route
        const errorCode = normalizeErrorToExecutionCode(err);
        await resolveTerminal(errorCode === "aborted" ? "aborted" : "error", {
          error: errorCode,
        });
        throw err;
      });

    return { stream: wrappedStream, final: wrappedFinal };
  }

  /**
   * Wrap stream to intercept events for terminal state tracking.
   */
  private wrapStream(
    stream: AsyncIterable<AiEvent>,
    hooks: {
      onAssistantFinal: (content: string) => void;
      onDone: () => void;
      onError: (code: string) => void;
    }
  ): AsyncIterable<AiEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = stream[Symbol.asyncIterator]();
        return {
          async next() {
            const result = await iterator.next();
            if (!result.done) {
              const event = result.value;
              if (event.type === "assistant_final") {
                hooks.onAssistantFinal(event.content);
              } else if (event.type === "done") {
                hooks.onDone();
              } else if (event.type === "error") {
                hooks.onError(event.error);
              }
            }
            return result;
          },
          async return(value?: unknown) {
            // Stream ended early (e.g., consumer stopped iterating)
            hooks.onDone();
            return iterator.return?.(value) ?? { done: true, value: undefined };
          },
          async throw(err?: unknown) {
            return iterator.throw?.(err) ?? { done: true, value: undefined };
          },
        };
      },
    };
  }
}
