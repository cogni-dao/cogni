// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities`
 * Purpose: Capability interfaces and helpers for tool implementations.
 * Scope: Defines tool-facing capability interfaces. Does NOT export from ai-core (capability interfaces live here).
 * Invariants:
 *   - AUTH_VIA_CAPABILITY_INTERFACE: Tools receive auth via capabilities, not context
 *   - NO_SECRETS_IN_CONTEXT: Capabilities resolve secrets, never stored in context
 *   - FIX_LAYERING_CAPABILITY_TYPES: Capability interfaces live here, NOT in ai-core
 * Side-effects: none
 * Links: TOOL_USE_SPEC.md #29, TENANT_CONNECTIONS_SPEC.md #9
 * @public
 */

// Hypothesis-loop capability (per knowledge-syntropy spec § The Hypothesis Loop)
export type {
  ChainDirection,
  ChainNodeEntry,
  DecideParams,
  EdoCapability,
  EdoSourceType,
  GetChainParams,
  GetChainResult,
  HypothesizeParams,
  RecordOutcomeParams,
  RecordOutcomeResult,
} from "./edo";
// Knowledge capability (per knowledge-data-plane spec)
export type {
  KnowledgeCapability,
  KnowledgeEntry,
  KnowledgeListParams,
  KnowledgeSearchParams,
  KnowledgeWriteParams,
} from "./knowledge";
export { CONFIDENCE } from "./knowledge";
// Metrics capability (per GOVERNED_METRICS invariant)
export type {
  MetricDataPoint,
  MetricQueryResult,
  MetricSummary,
  MetricsCapability,
  MetricTemplate,
  MetricWindow,
  TemplateQueryParams,
} from "./metrics";
// Repository capability (per COGNI_BRAIN_SPEC)
export type {
  RepoCapability,
  RepoListParams,
  RepoListResult,
  RepoOpenParams,
  RepoOpenResult,
  RepoSearchHit,
  RepoSearchParams,
  RepoSearchResult,
} from "./repo";
export { makeRepoCitation, REPO_CITATION_REGEX } from "./repo";
// Schedule management capability
export type {
  ScheduleCapability,
  ScheduleCreateParams,
  ScheduleInfo,
  ScheduleUpdateParams,
} from "./schedule";
// Export capability interfaces (defined here, NOT in ai-core)
export type {
  AuthCapability,
  ClockCapability,
  ToolCapabilities,
} from "./types";
// VCS capability (per VCS_WRITE_CAPABLE)
export type {
  CheckInfo,
  CiStatusResult,
  CreateBranchResult,
  DispatchCandidateFlightResult,
  MergeResult,
  PrSummary,
  VcsCapability,
} from "./vcs";
// Web search capability
export type {
  WebSearchCapability,
  WebSearchParams,
  WebSearchResult,
  WebSearchResultItem,
  WebSearchTopic,
} from "./web-search";
// Work item capability
export type {
  WorkItemAssignee,
  WorkItemCapability,
  WorkItemInfo,
  WorkItemQueryParams,
  WorkItemTransitionResult,
} from "./work-item";

import type { AuthCapability, ClockCapability } from "./types";

/**
 * Default clock capability using system time.
 * Used when no custom clock is injected (production path).
 */
export const systemClock: ClockCapability = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/**
 * Create a deterministic clock for testing.
 *
 * @param fixedTime - Fixed timestamp in milliseconds
 * @returns ClockCapability that always returns the fixed time
 */
export function createFixedClock(fixedTime: number): ClockCapability {
  const date = new Date(fixedTime);
  return {
    now: () => fixedTime,
    nowIso: () => date.toISOString(),
  };
}

/**
 * Stub auth capability that throws on any operation.
 * Used as placeholder when auth is not configured.
 */
export const stubAuthCapability: AuthCapability = {
  getAccessToken: async () => {
    throw new Error(
      "AuthCapability not configured. ConnectionBroker required for authenticated tools."
    );
  },
  getAuthHeaders: async () => {
    throw new Error(
      "AuthCapability not configured. ConnectionBroker required for authenticated tools."
    );
  },
};
