// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/pr-manager/tools`
 * Purpose: Tool ID constants for the PR Manager agent graph.
 * Scope: References tool IDs from @cogni/ai-tools. Does NOT import implementations.
 * Invariants: TOOL_CATALOG_IS_CANONICAL — IDs only, resolution at runtime.
 * Side-effects: none
 * Links: task.0242
 * @public
 */

import {
  REPO_OPEN_NAME,
  VCS_CREATE_BRANCH_NAME,
  VCS_FLIGHT_CANDIDATE_NAME,
  VCS_GET_CI_STATUS_NAME,
  VCS_LIST_PRS_NAME,
  VCS_MERGE_PR_NAME,
  WORK_ITEM_QUERY_NAME,
} from "@cogni/ai-tools";

/**
 * Tool IDs available to the PR Manager agent.
 *
 * - repo_open: reads the evolving playbook at https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/guides/pr-management-playbook.md
 * - VCS tools: PR lifecycle management (list / CI status / merge / branch / flight)
 * - work item query: cross-reference PR ↔ task
 *
 * NO_AUTO_FLIGHT invariant: `core__vcs_flight_candidate` must only be invoked
 * when a human or scheduled run explicitly requests a flight. The tool's own
 * description repeats this to the planner.
 */
export const PR_MANAGER_TOOL_IDS = [
  REPO_OPEN_NAME,
  VCS_LIST_PRS_NAME,
  VCS_GET_CI_STATUS_NAME,
  VCS_MERGE_PR_NAME,
  VCS_CREATE_BRANCH_NAME,
  VCS_FLIGHT_CANDIDATE_NAME,
  WORK_ITEM_QUERY_NAME,
] as const;
