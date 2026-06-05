// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/autoresearch/graph`
 * Purpose: Graph name constants and factory for Karpathy-style autoresearch agents.
 * Scope: Creates a prompt-driven ReAct agent and injects optional run spec config into the system prompt. Does not read env.
 * Invariants:
 *   - Pure factory function — no side effects, no env reads
 *   - TYPE_TRANSPARENT_RETURN: No explicit return type annotation to preserve CompiledStateGraph for CLI schema extraction
 * Side-effects: none
 * Links: docs/spec/graph-execution.md, work/projects/proj.ai-evals-pipeline.md
 * @public
 */

import { AutoresearchRunSpecSchema } from "@cogni/ai-core";
import type { BaseMessage } from "@langchain/core/messages";
import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { MessagesAnnotation } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { CreateReactAgentGraphOptions } from "../types";

export const AUTORESEARCH_SINGLE_LANE_GRAPH_NAME =
  "autoresearch-single-lane" as const;
export const AUTORESEARCH_SYNTROPY_LOOP_GRAPH_NAME =
  "autoresearch-syntropy-loop" as const;
export const AUTORESEARCH_REGISTRY_SWARM_GRAPH_NAME =
  "autoresearch-registry-swarm" as const;

interface AutoresearchPromptState {
  readonly messages?: BaseMessage[];
}

interface AutoresearchConfig extends RunnableConfig {
  readonly configurable?: {
    readonly autoresearch?: unknown;
    readonly autoresearchRunSpec?: unknown;
    readonly [key: string]: unknown;
  };
}

export function buildAutoresearchSystemPrompt(
  systemPrompt: string,
  rawSpec?: unknown
): string {
  if (rawSpec === undefined) return systemPrompt;

  const spec = AutoresearchRunSpecSchema.parse(rawSpec);
  const specJson = JSON.stringify(spec, null, 2);

  return `${systemPrompt}

AUTORESEARCH_RUN_SPEC:
\`\`\`json
${specJson}
\`\`\`

The AUTORESEARCH_RUN_SPEC above is authoritative. Use mission.objective and mission.question as the run mission. Do not substitute a generic autoresearch mission.

Your final JSON must echo this exact parsed object under a top-level runSpec key, then report rewardMetric.name, selectionPolicy, stopCriteriaHit, and driftGuardStopped.`;
}

function createAutoresearchPrompt(systemPrompt: string) {
  return (
    state: AutoresearchPromptState,
    config?: AutoresearchConfig
  ): BaseMessage[] => {
    const rawSpec =
      config?.configurable?.autoresearch ??
      config?.configurable?.autoresearchRunSpec;
    return [
      new SystemMessage(buildAutoresearchSystemPrompt(systemPrompt, rawSpec)),
      ...(state.messages ?? []),
    ];
  };
}

export function createAutoresearchGraph(opts: CreateReactAgentGraphOptions) {
  if (!opts.systemPrompt) {
    throw new Error(
      "createAutoresearchGraph requires systemPrompt — autoresearch graphs are prompt-driven via catalog"
    );
  }

  return createReactAgent({
    llm: opts.llm,
    tools: [...opts.tools],
    prompt: createAutoresearchPrompt(opts.systemPrompt),
    stateSchema: MessagesAnnotation,
  });
}
