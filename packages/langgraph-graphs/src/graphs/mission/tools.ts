// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/mission/tools`
 * Purpose: Tool IDs for mission-engine roles (Operating Review, Git Reviewer).
 * Scope: Exports tool capability metadata. Does NOT enforce policy.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: This is THE list of tools each mission-engine role can use
 *   - CAPABILITY_NOT_POLICY: These are capabilities, not authorization
 * Side-effects: none
 * Links: agent-roles spec, TOOL_USE_SPEC.md
 * @public
 */

import {
  GET_CURRENT_TIME_NAME,
  METRICS_QUERY_NAME,
  SCHEDULE_LIST_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_TRANSITION_NAME,
} from "@cogni/ai-tools";

/**
 * Tool IDs for Operating Review.
 * Read-mostly: query items, patch priority/labels, triage status transitions.
 * Schedule read-only (no SCHEDULE_MANAGE — planner must not modify its own schedule).
 */
export const OPERATING_REVIEW_TOOL_IDS = [
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_TRANSITION_NAME,
  GET_CURRENT_TIME_NAME,
  METRICS_QUERY_NAME,
  SCHEDULE_LIST_NAME,
] as const;

/**
 * Tool IDs for Git Reviewer.
 * Currently a queue observer only — no GitHub API access.
 * GitHub PR tools (read, comment) will be added when implemented.
 */
export const GIT_REVIEWER_TOOL_IDS = [GET_CURRENT_TIME_NAME] as const;
