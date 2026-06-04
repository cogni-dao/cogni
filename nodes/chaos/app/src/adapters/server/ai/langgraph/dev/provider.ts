// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/dev/provider`
 * Purpose: LangGraph dev server execution provider.
 * Scope: Implements GraphExecutorPort for langgraph dev. Uses SDK Client.runs.stream(). Does NOT handle production server (P1).
 * Invariants:
 *   - STABLE_GRAPH_IDS: providerId = "langgraph" (same as InProc)
 *   - MUTUAL_EXCLUSION: Either this or InProc registered, never both
 *   - OFFICIAL_SDK_ONLY: Uses @langchain/langgraph-sdk Client
 *   - THREAD_KEY_REQUIRED: stateKey required; derive threadId deterministically
 *   - STATEFUL_ONLY: Always send only last user message; server owns thread state
 *   - TOOL_CATALOG_IS_CANONICAL: Reads entry.toolIds for default catalog tools
 * Side-effects: IO (network calls to langgraph dev server)
 * Links: LANGGRAPH_SERVER.md (MVP section)
 * @internal
 */

import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import type { AiEvent } from "@cogni/node-core";
// biome-ignore lint/style/noRestrictedImports: SDK allowed in langgraph dev adapter per OFFICIAL_SDK_ONLY invariant
import type { Client } from "@langchain/langgraph-sdk";
import type { Logger } from "pino";
import { getExecutionScope } from "@/adapters/server/ai/execution-scope";
import type {
  AiExecutionErrorCode,
  ExecutionContext,
  GraphExecutorPort,
  GraphRunRequest,
  GraphRunResult,
} from "@/ports";
import { makeLogger } from "@/shared/observability";

import {
  type SdkStreamChunk,
  translateDevServerStream,
} from "./stream-translator";
import { buildThreadMetadata, deriveThreadUuid } from "./thread";

/**
 * Provider ID for LangGraph execution.
 * Per STABLE_GRAPH_IDS: same as InProc provider.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Configuration for LangGraphDevProvider.
 */
export interface LangGraphDevProviderConfig {
  /** Graph names available (keys from langgraph.json) */
  readonly availableGraphs: readonly string[];
}

/**
 * LangGraph dev server execution provider.
 *
 * Per STABLE_GRAPH_IDS: providerId = "langgraph" (same as InProc).
 * Per MUTUAL_EXCLUSION: Only one langgraph provider registered at runtime.
 * Per OFFICIAL_SDK_ONLY: Uses SDK Client.runs.stream().
 *
 * Connects to langgraph dev server (port 2024) for graph execution.
 */
export class LangGraphDevProvider implements GraphExecutorPort {
  readonly providerId = LANGGRAPH_PROVIDER_ID;
  private readonly log: Logger;
  private readonly availableGraphs: Set<string>;

  constructor(
    private readonly client: Client,
    config: LangGraphDevProviderConfig
  ) {
    this.log = makeLogger({ component: "LangGraphDevProvider" });
    this.availableGraphs = new Set(config.availableGraphs);

    this.log.debug(
      {
        graphCount: this.availableGraphs.size,
        graphs: [...this.availableGraphs],
      },
      "LangGraphDevProvider initialized"
    );
  }

  /**
   * Execute a graph run via langgraph dev server.
   *
   * Per OFFICIAL_SDK_ONLY: uses Client.runs.stream().
   * Per THREAD_KEY_REQUIRED: stateKey must be provided.
   * Per STATEFUL_ONLY: send only last user message; server owns thread state.
   */
  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const { runId, graphId, stateKey } = req;
    const scope = getExecutionScope();
    const requestId = ctx?.requestId ?? req.runId;

    // Per THREAD_KEY_REQUIRED: fail fast if not provided
    if (!stateKey) {
      this.log.error(
        { runId, graphId },
        "stateKey required for LangGraph Server"
      );
      return this.createErrorResult(runId, requestId, "invalid_request");
    }

    // Extract graph name from graphId
    const graphName = this.extractGraphName(graphId);
    if (!graphName) {
      this.log.error({ runId, graphId }, "Invalid graphId format");
      return this.createErrorResult(runId, requestId, "invalid_request");
    }

    if (!this.availableGraphs.has(graphName)) {
      this.log.error({ runId, graphName }, "Graph not found");
      return this.createErrorResult(runId, requestId, "not_found");
    }

    this.log.debug(
      { runId, graphName, stateKey, messageCount: req.messages.length },
      "LangGraphDevProvider.runGraph starting"
    );

    // Derive thread ID (UUIDv5) from (billingAccountId, stateKey)
    const threadId = deriveThreadUuid(scope.billing.billingAccountId, stateKey);
    const threadMetadata = buildThreadMetadata(
      scope.billing.billingAccountId,
      stateKey
    );

    // Create stream and final promise
    const { stream, final } = this.createStreamAndFinal(
      req,
      graphName,
      threadId,
      threadMetadata,
      requestId
    );

    return { stream, final };
  }

  /**
   * Create stream and final promise for graph execution.
   *
   * Uses single-consumer pattern: stream is consumed once, final is derived
   * from accumulated state during streaming.
   */
  private createStreamAndFinal(
    req: GraphRunRequest,
    graphName: string,
    threadId: string,
    threadMetadata: { billingAccountId: string; stateKey: string },
    requestId: string
  ): GraphRunResult {
    const { runId, messages, toolIds, modelRef, graphId } = req;
    const model = modelRef.modelId;
    const attempt = 0; // P0_ATTEMPT_FREEZE

    // P0 Contract: undefined => catalog default, [] => deny-all, [...] => exact
    const entry = LANGGRAPH_CATALOG[graphName];
    let resolvedToolIds: readonly string[];

    if (!entry) {
      // Config bug: graph in availableGraphs but not in catalog
      this.log.error(
        { runId, graphName },
        "Graph missing from LANGGRAPH_CATALOG; defaulting to deny-all"
      );
      resolvedToolIds = [];
    } else if (toolIds === undefined) {
      // undefined => catalog default (per TOOL_CATALOG_IS_CANONICAL)
      resolvedToolIds = entry.toolIds;
      this.log.debug(
        { runId, graphName, resolvedToolIds },
        "toolIds undefined; using catalog default per P0 contract"
      );
    } else {
      // [] or [...] => use exactly as provided (includes explicit deny-all)
      resolvedToolIds = toolIds;
    }

    // Shared state for deriving final result
    const state = {
      content: "",
      hasError: false,
      resolve: null as null | ((final: import("@/ports").GraphFinal) => void),
    };

    // Final promise resolves when stream completes
    const final = new Promise<import("@/ports").GraphFinal>((resolve) => {
      state.resolve = resolve;
    });

    // Create stream that yields events and updates shared state
    const stream = this.createStreamWithFinalState(
      graphName,
      threadId,
      threadMetadata,
      messages,
      { runId, attempt, graphId },
      state,
      runId,
      requestId,
      resolvedToolIds,
      model
    );

    return { stream, final };
  }

  /**
   * Create stream that yields events and resolves final when complete.
   *
   * Single-consumer pattern: only one iteration over the SDK stream.
   * Final state is derived from events as they're yielded.
   *
   * Per TOOL_CONFIG_PROPAGATION: passes toolIds via config.configurable
   * for wrapper authorization check.
   */
  private async *createStreamWithFinalState(
    graphName: string,
    threadId: string,
    threadMetadata: { billingAccountId: string; stateKey: string },
    messages: GraphRunRequest["messages"],
    ctx: {
      runId: string;
      attempt: number;
      graphId: GraphRunRequest["graphId"];
    },
    state: {
      content: string;
      hasError: boolean;
      resolve: null | ((final: import("@/ports").GraphFinal) => void);
    },
    runId: string,
    requestId: string,
    resolvedToolIds: readonly string[],
    model: string
  ): AsyncIterable<AiEvent> {
    try {
      // Ensure thread exists (idempotent create)
      await this.client.threads.create({
        threadId,
        ifExists: "do_nothing",
        metadata: threadMetadata,
      });

      // Per STATEFUL_ONLY: send only last user message; server owns thread state
      const lastUserMessage = [...messages]
        .reverse()
        .find((m) => m.role === "user");
      if (!lastUserMessage) {
        this.log.error(
          { runId: ctx.runId },
          "No user message found in request"
        );
        throw new Error("No user message found");
      }

      // Start streaming run
      // Per MODEL_VIA_CONFIGURABLE + TOOL_CONFIG_PROPAGATION: pass model and toolIds
      // Per EXTERNAL_BILLING_VIA_RECONCILIATION: pass user=${runId}/${attempt} for spend_logs attribution
      const sdkStream = this.client.runs.stream(threadId, graphName, {
        input: { messages: [lastUserMessage] },
        streamMode: ["messages-tuple"],
        config: {
          configurable: {
            model,
            toolIds: [...resolvedToolIds],
            user: `${ctx.runId}/${ctx.attempt}`,
          },
        },
      });

      // Translate SDK stream to AiEvents
      const translatedStream = translateDevServerStream(
        sdkStream as AsyncIterable<SdkStreamChunk>,
        ctx
      );

      // Yield events and accumulate state
      for await (const event of translatedStream) {
        // Track state for final result
        if (event.type === "text_delta") {
          state.content += event.delta;
        }
        if (event.type === "error") {
          state.hasError = true;
        }

        yield event;
      }

      // Resolve final promise after stream completes
      if (state.resolve) {
        state.resolve({
          ok: true,
          runId,
          requestId,
          finishReason: "stop",
          content: state.content,
        });
      }
    } catch (error) {
      this.log.error(
        { runId: ctx.runId, error },
        "LangGraphDevProvider stream error"
      );

      yield { type: "error", error: "internal" };
      yield { type: "done" };

      // Resolve final promise with error
      if (state.resolve) {
        state.resolve({
          ok: false,
          runId,
          requestId,
          error: "internal",
        });
      }
    }
  }

  /**
   * Extract graph name from namespaced graphId.
   */
  private extractGraphName(graphId: string): string | undefined {
    const prefix = `${this.providerId}:`;
    if (graphId.startsWith(prefix)) {
      return graphId.slice(prefix.length);
    }
    return undefined;
  }

  /**
   * Create error result for invalid requests.
   */
  private createErrorResult(
    runId: string,
    requestId: string,
    code: AiExecutionErrorCode
  ): GraphRunResult {
    const errorStream = (async function* () {
      yield { type: "error" as const, error: code };
      yield { type: "done" as const };
    })();

    return {
      stream: errorStream,
      final: Promise.resolve({
        ok: false as const,
        runId,
        requestId,
        error: code,
      }),
    };
  }
}
