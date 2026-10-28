// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/runtime/cogni/make-cogni-graph`
 * Purpose: Create compiled graph for Cogni executor (Next.js runtime).
 * Scope: Wiring-only helper. Does NOT import LANGGRAPH_CATALOG. Does NOT enforce policy.
 * Invariants:
 *   - HELPERS_DO_NOT_IMPORT_GRAPH_CATALOG: No LANGGRAPH_CATALOG import (type transparency); TOOL_CATALOG allowed
 *   - HELPERS_DO_NOT_ENFORCE_POLICY: Policy is ToolRunner's job
 *   - SYNC_HELPER: This function is sync (ALS reads happen at invoke time)
 *   - NO_CONSTRUCTOR_ARGS: Uses no-arg CogniCompletionAdapter
 *   - NO_HIDDEN_DEFAULT_MODEL: CogniCompletionAdapter fails fast if configurable.model missing
 *   - FAIL_FAST_ON_MISSING_TOOLS: Throw if toolIds reference tools not in TOOL_CATALOG
 *   - TOOLS_VIA_ALS: Tools read toolExecFn from ALS at invocation time
 *   - TYPE_TRANSPARENT_RETURN: Returns ReturnType<TCreateGraph> to preserve concrete types
 * Side-effects: none
 * Links: GRAPH_EXECUTION.md, LANGGRAPH_AI.md
 * @public
 */

import { type CatalogBoundTool, TOOL_CATALOG } from "@cogni/ai-tools";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type { CreateReactAgentGraphOptions } from "../../graphs/types";
import { CogniCompletionAdapter } from "./completion-adapter";
import { toLangChainToolsFromContext } from "./tools";

/**
 * Create a compiled graph for Cogni executor (Next.js runtime).
 *
 * Per SYNC_HELPER: This function is sync. ALS reads happen at invoke time.
 *
 * Per NO_CONSTRUCTOR_ARGS: Creates no-arg CogniCompletionAdapter that reads
 * completionFn/tokenSink from ALS and model from configurable at invoke time.
 *
 * Per TOOLS_VIA_ALS: Tools use toLangChainToolsFromContext which reads
 * toolExecFn from ALS at invocation time.
 *
 * Per TYPE_TRANSPARENT_RETURN: Generic over TCreateGraph and returns
 * ReturnType<TCreateGraph> to preserve concrete graph types.
 *
 * Per HELPERS_DO_NOT_IMPORT_CATALOG: Takes explicit toolIds, no catalog lookup.
 * Per HELPERS_DO_NOT_ENFORCE_POLICY: Tool wiring only; policy is ToolRunner's job.
 *
 * @param opts - Options with name, createGraph factory, and toolIds
 * @returns Compiled graph ready for invoke (within ALS context)
 *
 * @example
 * ```typescript
 * // graphs/poet/cogni-exec.ts
 * export const poetGraph = makeCogniGraph({
 *   name: POET_GRAPH_NAME,
 *   createGraph: createPoetGraph,
 *   toolIds: POET_TOOL_IDS,
 * });
 * ```
 */
export function makeCogniGraph<
  TCreateGraph extends (opts: CreateReactAgentGraphOptions) => unknown,
>(opts: {
  /** Graph name (for error messages) */
  readonly name: string;
  /** Pure graph factory function */
  readonly createGraph: TCreateGraph;
  /** Tool IDs this graph uses (from per-graph tools.ts) */
  readonly toolIds: readonly string[];
  /** Trusted catalog program assignment (e.g. "cogni"); never from model/tool content. */
  readonly program?: CreateReactAgentGraphOptions["program"];
}): ReturnType<TCreateGraph> {
  const { name, createGraph, toolIds } = opts;

  // Resolve bound tools from TOOL_CATALOG
  const boundTools: Readonly<Record<string, CatalogBoundTool>> =
    Object.fromEntries(
      toolIds
        .map((id) => [id, TOOL_CATALOG[id]] as const)
        .filter(
          (entry): entry is [string, CatalogBoundTool] => entry[1] !== undefined
        )
    );

  // Fail fast if tools missing (per FAIL_FAST_ON_MISSING_TOOLS)
  const missingTools = toolIds.filter((id) => !boundTools[id]);
  if (missingTools.length > 0) {
    throw new Error(
      `[makeCogniGraph:${name}] Missing tools in TOOL_CATALOG: ${missingTools.join(", ")}. ` +
        `Ensure all tool IDs in toolIds exist in @cogni/ai-tools TOOL_CATALOG.`
    );
  }

  // Create no-arg CogniCompletionAdapter (reads from ALS + configurable at invoke)
  const llm = new CogniCompletionAdapter();

  // Convert to LangChain tools (context wrapper reads toolExecFn from ALS)
  const toolContracts = Object.values(boundTools).map((bt) => bt.contract);
  const tools: StructuredToolInterface[] = toLangChainToolsFromContext({
    contracts: toolContracts,
  });

  // Create graph using factory - cast preserves concrete return type
  return createGraph({
    llm,
    tools,
    ...(opts.program ? { program: opts.program } : {}),
  }) as ReturnType<TCreateGraph>;
}
