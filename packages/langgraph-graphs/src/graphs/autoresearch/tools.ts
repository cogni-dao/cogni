// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/autoresearch/tools`
 * Purpose: Tool IDs for autoresearch graph variants.
 * Scope: Exports capability metadata only. Does NOT enforce policy.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: This is THE list of tools autoresearch variants can use
 *   - CAPABILITY_NOT_POLICY: These are capabilities, not authorization
 * Side-effects: none
 * Links: docs/spec/tool-use.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import {
  EDO_DECIDE_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_RECORD_OUTCOME_NAME,
  GET_CURRENT_TIME_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_WRITE_NAME,
  REPO_LIST_NAME,
  REPO_OPEN_NAME,
  REPO_SEARCH_NAME,
  VCS_GET_CI_STATUS_NAME,
  VCS_LIST_PRS_NAME,
  WEB_SEARCH_NAME,
} from "@cogni/ai-tools";

export const AUTORESEARCH_TOOL_IDS = [
  GET_CURRENT_TIME_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_WRITE_NAME,
  REPO_LIST_NAME,
  REPO_SEARCH_NAME,
  REPO_OPEN_NAME,
  VCS_LIST_PRS_NAME,
  VCS_GET_CI_STATUS_NAME,
  WEB_SEARCH_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_DECIDE_NAME,
  EDO_RECORD_OUTCOME_NAME,
] as const;

export type AutoresearchToolId = (typeof AUTORESEARCH_TOOL_IDS)[number];
