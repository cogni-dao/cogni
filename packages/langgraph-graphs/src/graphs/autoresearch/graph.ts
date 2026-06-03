// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/autoresearch/graph`
 * Purpose: Graph name constants and factory for Karpathy-style autoresearch agents.
 * Scope: Reuses the prompt-driven ReAct operator graph factory. Does not execute graphs or read env.
 * Invariants:
 *   - Pure factory function — no side effects, no env reads
 *   - TYPE_TRANSPARENT_RETURN: No explicit return type annotation to preserve CompiledStateGraph for CLI schema extraction
 * Side-effects: none
 * Links: docs/spec/graph-execution.md, work/projects/proj.ai-evals-pipeline.md
 * @public
 */

import { createOperatorGraph } from "../operator/graph";
import type { CreateReactAgentGraphOptions } from "../types";

export const AUTORESEARCH_SINGLE_LANE_GRAPH_NAME =
  "autoresearch-single-lane" as const;
export const AUTORESEARCH_SYNTROPY_LOOP_GRAPH_NAME =
  "autoresearch-syntropy-loop" as const;
export const AUTORESEARCH_REGISTRY_SWARM_GRAPH_NAME =
  "autoresearch-registry-swarm" as const;

export function createAutoresearchGraph(opts: CreateReactAgentGraphOptions) {
  return createOperatorGraph(opts);
}
