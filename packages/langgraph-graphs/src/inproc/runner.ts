// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/runner`
 * Purpose: InProc graph execution runner for Next.js server runtime.
 * Scope: Creates queue, wires dependencies, executes graph via ALS context, emits events. Does NOT import from src/.
 * Invariants:
 *   - SINGLE_QUEUE_PER_RUN: Runner creates queue, passes emit to createToolExecFn
 *   - RUNTIME_CONTEXT_VIA_ALS: Sets up ALS context (completionFn, tokenSink, toolExecFn) before graph invocation
 *   - NO_MODEL_IN_ALS (#35): Model comes from configurable.model, never ALS
 *   - ASSISTANT_FINAL_REQUIRED: Emits exactly one assistant_final event on success; none on error
 *   - NO_AWAIT_IN_TOKEN_PATH: tokenSink.push() is synchronous
 *   - RESULT_REFLECTS_OUTCOME: final.ok matches stream success/failure
 *   - ERROR_NORMALIZATION_ONCE: Catch block uses normalizeErrorToExecutionCode()
 *   - USAGE_AGGREGATION_PER_RUN: Usage aggregated from usage_report events, not LLM instance
 * Side-effects: IO (executes graph, emits events)
 * Links: LANGGRAPH_AI.md, ERROR_HANDLING_ARCHITECTURE.md, GRAPH_EXECUTION.md
 * @public
 */

import {
  type AiEvent,
  normalizeErrorToExecutionCode,
  type ToolSpec,
} from "@cogni/ai-core";
import type { BaseMessage } from "@langchain/core/messages";
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import {
  CogniCompletionAdapter,
  type CompletionFn,
  runWithCogniExecContext,
} from "../runtime/cogni";
import {
  AsyncQueue,
  type ToolExecFn,
  toBaseMessage,
  toLangChainToolsCaptured,
} from "../runtime/core";

import type { GraphResult, InProcRunnerOptions } from "./types";

/**
 * Create LangChain tool wrappers from MCP ToolSpecs.
 * These delegate to toolExecFn which routes through toolRunner (policy, billing, redaction).
 */
function mcpSpecsToLangChainTools(
  specs: readonly ToolSpec[],
  toolExecFn: ToolExecFn
): StructuredToolInterface[] {
  return specs.map(
    (spec) =>
      new DynamicStructuredTool({
        name: spec.name,
        description: spec.description,
        // Passthrough schema — MCP tools validate internally via BoundToolRuntime
        schema: z.record(z.unknown()),
        func: async (args: Record<string, unknown>): Promise<string> => {
          const result = await toolExecFn(spec.name, args, undefined);
          if (!result.ok) {
            return JSON.stringify({
              error: result.receipt?.code ?? result.errorCode,
              message: result.safeMessage,
              ...(result.receipt
                ? { retryable: false, lookup: result.receipt.lookup }
                : {}),
            });
          }
          return typeof result.value === "string"
            ? result.value
            : JSON.stringify(result.value);
        },
      }) as StructuredToolInterface
  );
}

/**
 * Extract text content from final assistant message.
 * LangGraph returns messages array; last message is assistant response.
 */
function extractAssistantContent(messages: BaseMessage[]): string {
  if (messages.length === 0) return "";

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return "";

  if (typeof lastMessage.content === "string") {
    return lastMessage.content;
  }

  if (Array.isArray(lastMessage.content)) {
    return lastMessage.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text"
      )
      .map((part) => part.text)
      .join("");
  }

  return "";
}

/**
 * Create InProc graph runner.
 *
 * Generic runner that accepts a graph factory from the catalog.
 * All LangChain logic is contained here — callers don't need LangChain imports.
 *
 * Per SINGLE_QUEUE_PER_RUN: Runner creates queue internally.
 * Per RUNTIME_CONTEXT_VIA_ALS: Sets up ALS before graph invocation.
 * Per ASSISTANT_FINAL_REQUIRED: Emits exactly one assistant_final event.
 *
 * @param opts - Runner options including graph factory
 * @returns { stream, final } - AsyncIterable of events and Promise of result
 */
export function createInProcGraphRunner<TTool = unknown>(
  opts: InProcRunnerOptions<TTool>
): {
  stream: AsyncIterable<AiEvent>;
  final: Promise<GraphResult>;
} {
  const {
    createGraph,
    completionFn,
    createToolExecFn,
    toolContracts,
    mcpToolSpecs,
    request,
    responseFormat,
    systemPrompt,
  } = opts;

  // SINGLE_QUEUE_PER_RUN: Runner creates queue, all events flow here
  const queue = new AsyncQueue<AiEvent>();

  // Per-run usage aggregation (concurrency-safe: one runner per run)
  // Accumulated from usage_report events, not LLM instance
  let collectedUsage: {
    promptTokens: number;
    completionTokens: number;
  } | null = null;

  const emit = (e: AiEvent): void => {
    // Aggregate usage from usage_report events (per USAGE_AGGREGATION_PER_RUN)
    if (e.type === "usage_report" && e.fact?.inputTokens !== undefined) {
      if (collectedUsage === null) {
        collectedUsage = { promptTokens: 0, completionTokens: 0 };
      }
      collectedUsage.promptTokens += e.fact.inputTokens ?? 0;
      collectedUsage.completionTokens += e.fact.outputTokens ?? 0;
    }
    queue.push(e);
  };

  const tokenSink = { push: emit };
  const toolExecFn = createToolExecFn(emit);

  // Create no-arg CogniCompletionAdapter (reads from ALS + configurable at invoke time)
  const llm = new CogniCompletionAdapter();

  // Use toLangChainToolsCaptured since runner provides toolExecFn directly (not from ALS)
  const contractTools = toLangChainToolsCaptured({
    contracts: toolContracts,
    toolExecFn,
  });

  // Merge MCP tool wrappers (delegate to same toolExecFn → toolRunner pipeline)
  const mcpTools =
    mcpToolSpecs && mcpToolSpecs.length > 0
      ? mcpSpecsToLangChainTools(mcpToolSpecs, toolExecFn)
      : [];
  const tools =
    mcpTools.length > 0 ? [...contractTools, ...mcpTools] : contractTools;

  // Use factory from catalog instead of hardcoded graph
  const graph = createGraph({
    llm,
    tools,
    ...(responseFormat !== undefined && { responseFormat }),
    ...(systemPrompt !== undefined && { systemPrompt }),
  });

  const final = (async (): Promise<GraphResult> => {
    try {
      const messages = request.messages.map(toBaseMessage);

      // Set up ALS context and invoke graph
      // Per #35 NO_MODEL_IN_ALS: model comes from configurable, not ALS
      // Per #36 ALS_ONLY_FOR_NON_SERIALIZABLE_DEPS: ALS holds only completionFn, tokenSink, toolExecFn
      const result = await runWithCogniExecContext(
        {
          completionFn: completionFn as CompletionFn<unknown>,
          tokenSink,
          toolExecFn,
        },
        () =>
          graph.invoke(
            { messages },
            {
              signal: request.abortSignal,
              configurable: request.configurable,
            }
          )
      );

      const assistantContent = extractAssistantContent(result.messages);

      // Extract structured response if present (from responseFormat graphs)
      const structuredOutput =
        result.structuredResponse !== undefined
          ? (result.structuredResponse as Record<string, unknown>)
          : undefined;

      // ASSISTANT_FINAL_REQUIRED: exactly one per run
      emit({ type: "assistant_final", content: assistantContent });
      emit({ type: "done" });

      // Omit usage when null (never default to zeros)
      // Per USAGE_AGGREGATION_PER_RUN: usage aggregated from usage_report events
      return {
        ok: true,
        finishReason: "stop",
        content: assistantContent,
        ...(collectedUsage !== null && { usage: collectedUsage }),
        ...(structuredOutput !== undefined && { structuredOutput }),
      };
    } catch (error) {
      // Normalize error using duck-typed LlmError detection (kind/status properties)
      // Per ERROR_NORMALIZATION_ONCE: normalize at catch boundary
      const code = normalizeErrorToExecutionCode(error);

      // Capture error message for logging at adapter boundary (not sent to clients)
      const errorMessage =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);

      // Per ERROR_NORMALIZATION: emit code only, not message
      emit({ type: "error", error: code });
      // Per GRAPH_FINALIZATION_ONCE: always emit done as final event
      emit({ type: "done" });

      return { ok: false, error: code, errorMessage };
    } finally {
      queue.close();
    }
  })();

  return { stream: queue, final };
}
