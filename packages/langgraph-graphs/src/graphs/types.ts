// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/types`
 * Purpose: Shared graph type definitions for all LangGraph agents.
 * Scope: Type firewall for LangGraph generics. Does NOT implement graph logic.
 * Invariants:
 *   - SINGLE_INVOKABLE_INTERFACE: All graphs implement InvokableGraph<I,O>
 *   - LANGCHAIN_ALIGNED: Uses RunnableConfig/RunnableInterface from @langchain/core
 * Side-effects: none
 * Links: LANGGRAPH_AI.md, AGENT_DEVELOPMENT_GUIDE.md
 * @public
 */

import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  RunnableConfig,
  RunnableInterface,
} from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";

/**
 * Options for graph invocation.
 * Alias to Partial<RunnableConfig> matching RunnableInterface.invoke() signature.
 *
 * Includes: signal, configurable, metadata, tags, callbacks, runId, timeout, etc.
 */
export type GraphInvokeOptions = Partial<RunnableConfig>;

/**
 * Generic invokable graph interface.
 * Type firewall: exposes only invoke() from RunnableInterface.
 *
 * @typeParam I - Input type (e.g., { messages: BaseMessage[] })
 * @typeParam O - Output type (e.g., { messages: BaseMessage[] })
 */
export type InvokableGraph<I, O> = Pick<RunnableInterface<I, O>, "invoke">;

/**
 * Standard input/output types for message-based graphs.
 * NOTE: Mutable arrays to align with LangGraph's UpdateType expectations.
 * Immutability should be enforced at runtime after validation, not in boundary types.
 */
export type MessageGraphInput = { messages: BaseMessage[] };
export type MessageGraphOutput = { messages: BaseMessage[] };

/**
 * Base options for React agent graph factories.
 * Extend per-graph when additional dependencies are needed.
 */
export interface CreateReactAgentGraphOptions {
  /** Sanitized observation of isolated SDK state operations; never arbitrary scratch content. */
  readonly onInternalToolEvent?: (event: {
    id: string;
    name: string;
    status: "start" | "success" | "error";
  }) => void;
  /** Host-bound source provenance, never accepted from model/tool arguments. */
  readonly sourceContext?: {
    readonly nodeId: string;
    readonly origin: string;
    readonly mission?: {
      readonly content: string;
      readonly sourceRef: string;
      readonly buildSha: string | null;
    };
    /**
     * Host-owned governing index (same `listGoverningIndex` the cognition bundle renders):
     * id · domain · entryType · useWhen metadata held in context so an agent selects its
     * guidance and reads each body on demand (guidance-routing-design progressive disclosure).
     */
    readonly governingIndex?: ReadonlyArray<{
      readonly id: string;
      readonly domain: string;
      readonly entryType: string;
      readonly useWhen: string;
    }>;
  };
  /** Trusted catalog assignment; never supplied by model/tool content. */
  readonly program?: "cogni" | "work-review";
  /** LLM instance - LanguageModelLike to match createReactAgent expectation */
  readonly llm: LanguageModelLike;
  /** Tools wrapped via toLangChainTools() */
  readonly tools: ReadonlyArray<StructuredToolInterface>;
  /** Optional structured output format. When set, graph returns `structuredResponse`. */
  readonly responseFormat?: {
    readonly prompt?: string;
    readonly schema: unknown;
  };
  /** Optional system prompt override. Used by operator graphs that are configured via catalog. */
  readonly systemPrompt?: string;
  /**
   * LangGraph persistence foundation (langgraph-persistence). When present, the engine compiles
   * with a checkpointer — per-run/thread state under a stable `thread_id`, resumable within a run —
   * and a `Store` for cross-thread working memory. This is the prerequisite for deep-agent depth
   * (write_todos planning, reflection, SubAgentMiddleware). Absent ⇒ the graph compiles with no
   * persistence, so the pure structure still renders in langgraph dev. The host injects a stable
   * `thread_id` at the invoke seam; the checkpointer/store backend is dev `MemorySaver`/`InMemoryStore`
   * and prod `PostgresSaver`/store (`.setup()` at deploy, never at request time). Durable syntropy
   * memory remains the hub; the checkpointer/store hold only per-run working state.
   */
  readonly checkpointer?: BaseCheckpointSaver;
  readonly store?: BaseStore;
}
