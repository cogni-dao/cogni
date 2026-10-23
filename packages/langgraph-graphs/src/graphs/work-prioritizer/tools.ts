// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/tools`
 * Purpose: Tool IDs for the mission-loop agent (single source of truth).
 * Scope: Exports tool capability metadata. Does NOT enforce policy (the toolRunner + work-item store do).
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: This is THE list of tools the mission loop can use
 *   - CAPABILITY_NOT_POLICY: p0/p1 writes are denied server-side (P0P1_IS_NODE_ADMIN), not here
 * Side-effects: none
 * Links: story.5108, TOOL_USE_SPEC.md
 * @public
 */

import {
  EDO_DECIDE_NAME,
  GET_CURRENT_TIME_NAME,
  GOAL_LIST_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_TRANSITION_NAME,
} from "@cogni/ai-tools";

export const WORK_PRIORITIZER_TOOL_IDS = [
  GOAL_LIST_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_TRANSITION_NAME,
  KNOWLEDGE_SEARCH_NAME,
  EDO_DECIDE_NAME,
  GET_CURRENT_TIME_NAME,
] as const;
