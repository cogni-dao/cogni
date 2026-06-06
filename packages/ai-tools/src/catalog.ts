// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/catalog`
 * Purpose: Core tool bundle, optional control-plane bundles, and id-keyed views.
 * Scope: Exports CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE, TOOL_CATALOG, and createToolCatalog. Does NOT import @langchain, does NOT contain node-only tools (those live in nodes/<node>/packages/ai-tools/).
 * Invariants:
 *   - CORE_BUNDLE_IS_SHARED: CORE_TOOL_BUNDLE is safe for every node runtime.
 *   - VCS_TOOLS_ARE_CONTROL_PLANE: VCS tools are composed by operator only.
 *   - TOOL_ID_STABILITY: Duplicate IDs throw at construction time
 *   - TOOL_ID_NAMESPACED: IDs use core__<name> format
 * Side-effects: none
 * Links: docs/spec/tool-use.md, work/items/bug.0319.ai-tools-per-node-packages.md
 * @public
 */

import { edoDecideBoundTool } from "./tools/edo-decide";
import { edoHypothesizeBoundTool } from "./tools/edo-hypothesize";
import { edoRecordOutcomeBoundTool } from "./tools/edo-record-outcome";
import { getCurrentTimeBoundTool } from "./tools/get-current-time";
import { knowledgeReadBoundTool } from "./tools/knowledge-read";
import { knowledgeSearchBoundTool } from "./tools/knowledge-search";
import { knowledgeWriteBoundTool } from "./tools/knowledge-write";
import { metricsQueryBoundTool } from "./tools/metrics-query";
import { repoListBoundTool } from "./tools/repo-list";
import { repoOpenBoundTool } from "./tools/repo-open";
import { repoSearchBoundTool } from "./tools/repo-search";
import { scheduleListBoundTool } from "./tools/schedule-list";
import { scheduleManageBoundTool } from "./tools/schedule-manage";
import { vcsCreateBranchBoundTool } from "./tools/vcs-create-branch";
import { vcsFlightCandidateBoundTool } from "./tools/vcs-flight-candidate";
import { vcsGetCiStatusBoundTool } from "./tools/vcs-get-ci-status";
import { vcsListPrsBoundTool } from "./tools/vcs-list-prs";
import { vcsMergePrBoundTool } from "./tools/vcs-merge-pr";
import { webSearchBoundTool } from "./tools/web-search";
import { workItemQueryBoundTool } from "./tools/work-item-query";
import { workItemTransitionBoundTool } from "./tools/work-item-transition";
import type { BoundTool } from "./types";

/**
 * Generic bound tool type for catalog entries.
 * Uses widened types to allow any conforming BoundTool.
 */
export type CatalogBoundTool = BoundTool<
  string,
  unknown,
  unknown,
  Record<string, unknown>
>;

/**
 * Tool catalog type.
 * Maps tool ID → BoundTool.
 */
export type ToolCatalog = Readonly<Record<string, CatalogBoundTool>>;

/**
 * Create a tool catalog from an array of bound tools.
 * Validates uniqueness of tool IDs at construction time.
 *
 * @param tools - Array of bound tools to register
 * @returns Frozen tool catalog
 * @throws Error if duplicate tool IDs are detected
 *
 * @example
 * ```typescript
 * const catalog = createToolCatalog([
 *   getCurrentTimeBoundTool,
 *   webSearchBoundTool,
 * ]);
 * ```
 */
export function createToolCatalog(
  tools: readonly CatalogBoundTool[]
): ToolCatalog {
  const catalog: Record<string, CatalogBoundTool> = {};

  for (const tool of tools) {
    const toolId = tool.contract.name;

    // TOOL_ID_STABILITY: Throw on duplicate, never silently overwrite
    if (toolId in catalog) {
      throw new Error(
        `TOOL_ID_STABILITY violation: Duplicate tool ID "${toolId}" in catalog. ` +
          "Tool IDs must be unique. Check for duplicate registrations."
      );
    }

    catalog[toolId] = tool;
  }

  return Object.freeze(catalog);
}

/**
 * CORE_TOOL_BUNDLE: cross-node core tool bundle. These tools are safe to expose
 * in every node runtime.
 *
 * Each node's bootstrap imports this directly:
 *   - Non-poly nodes: `createBoundToolSource([...CORE_TOOL_BUNDLE], toolBindings)`
 *   - Operator node: `createBoundToolSource([...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE], toolBindings)`
 *   - Poly-style node packages may add their own node-owned bundle.
 *
 * Adding a new core tool means every node can safely run it. Operator deploy,
 * PR, and GitHub App control-plane tools belong in VCS_TOOL_BUNDLE or an
 * operator-owned package instead.
 */
export const CORE_TOOL_BUNDLE: readonly CatalogBoundTool[] = [
  edoDecideBoundTool as CatalogBoundTool,
  edoHypothesizeBoundTool as CatalogBoundTool,
  edoRecordOutcomeBoundTool as CatalogBoundTool,
  getCurrentTimeBoundTool as CatalogBoundTool,
  knowledgeReadBoundTool as CatalogBoundTool,
  knowledgeSearchBoundTool as CatalogBoundTool,
  knowledgeWriteBoundTool as CatalogBoundTool,
  metricsQueryBoundTool as CatalogBoundTool,
  repoListBoundTool as CatalogBoundTool,
  repoOpenBoundTool as CatalogBoundTool,
  repoSearchBoundTool as CatalogBoundTool,
  scheduleListBoundTool as CatalogBoundTool,
  scheduleManageBoundTool as CatalogBoundTool,
  webSearchBoundTool as CatalogBoundTool,
  workItemQueryBoundTool as CatalogBoundTool,
  workItemTransitionBoundTool as CatalogBoundTool,
];

/**
 * VCS_TOOL_BUNDLE: GitHub/VCS control-plane tools. The operator composes this
 * bundle because it owns the GitHub App and CI/CD authority. Sovereign node
 * runtimes should call operator APIs instead of receiving direct VCS tools.
 */
export const VCS_TOOL_BUNDLE: readonly CatalogBoundTool[] = [
  vcsCreateBranchBoundTool as CatalogBoundTool,
  vcsFlightCandidateBoundTool as CatalogBoundTool,
  vcsGetCiStatusBoundTool as CatalogBoundTool,
  vcsListPrsBoundTool as CatalogBoundTool,
  vcsMergePrBoundTool as CatalogBoundTool,
];

/**
 * TOOL_CATALOG: id-keyed view of package-defined tools.
 *
 * Runtime node exposure is controlled by the bundle each node composes, not by
 * this package-wide lookup. This view is kept for graph helpers and tests that
 * resolve package tool IDs by name.
 *
 * Derived from the hand-maintained bundles so the lookup cannot drift. Consumed by
 * `@cogni/langgraph-graphs/runtime/{core/make-server-graph,cogni/make-cogni-graph}`
 * which look core tools up by ID for the FAIL_FAST_ON_MISSING_TOOLS invariant.
 *
 * Per TOOL_ID_STABILITY: duplicate IDs throw at construction time (inside
 * createToolCatalog).
 *
 * Node-only tool catalogs do not appear here. Each runtime composes the tools it
 * exposes from explicit bundles.
 */
export const TOOL_CATALOG: ToolCatalog = createToolCatalog([
  ...CORE_TOOL_BUNDLE,
  ...VCS_TOOL_BUNDLE,
]);

/**
 * Get all tool IDs in the catalog.
 */
export function getToolIds(): readonly string[] {
  return Object.keys(TOOL_CATALOG);
}

/**
 * Get a tool by ID from the catalog.
 * Returns undefined if not found.
 */
export function getToolById(toolId: string): CatalogBoundTool | undefined {
  return TOOL_CATALOG[toolId];
}

/**
 * Check if a tool ID exists in the catalog.
 */
export function hasToolId(toolId: string): boolean {
  return toolId in TOOL_CATALOG;
}
