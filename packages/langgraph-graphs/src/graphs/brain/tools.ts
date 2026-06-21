// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/brain/tools`
 * Purpose: Tool IDs for brain graph (single source of truth).
 * Scope: Exports tool capability metadata. Does NOT enforce policy (that's ToolRunner's job).
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: This is THE list of tools brain can use
 *   - CAPABILITY_NOT_POLICY: These are capabilities, not authorization
 * Side-effects: none
 * Links: COGNI_BRAIN_SPEC.md, TOOL_USE_SPEC.md
 * @public
 */

import {
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_WRITE_NAME,
  REPO_LIST_NAME,
  REPO_OPEN_NAME,
  REPO_SEARCH_NAME,
  SCHEDULE_LIST_NAME,
  SCHEDULE_MANAGE_NAME,
  VCS_GET_CI_STATUS_NAME,
  VCS_LIST_PRS_NAME,
} from "@cogni/ai-tools";

/**
 * Tool IDs for brain graph.
 * Single source of truth - imported by server.ts, cogni-exec.ts, and catalog.ts.
 *
 * VCS tools are READ-ONLY here: brain can see open PRs + CI status so it answers
 * "what were the most recent PRs?" with real GitHub state instead of falling back
 * to knowledge_search. Mutating VCS tools (merge / create-branch / flight) stay
 * exclusive to the operator `pr_manager` graph — a user-facing assistant must not
 * perform destructive GitHub operations.
 */
export const BRAIN_TOOL_IDS = [
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_WRITE_NAME,
  REPO_LIST_NAME,
  REPO_SEARCH_NAME,
  REPO_OPEN_NAME,
  VCS_LIST_PRS_NAME,
  VCS_GET_CI_STATUS_NAME,
  SCHEDULE_LIST_NAME,
  SCHEDULE_MANAGE_NAME,
] as const;

/**
 * Type for brain tool IDs.
 */
export type BrainToolId = (typeof BRAIN_TOOL_IDS)[number];
