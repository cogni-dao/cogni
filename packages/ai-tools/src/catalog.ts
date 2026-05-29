// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/catalog`
 * Purpose: Core tool bundle + id-keyed view, plus the shared createToolCatalog helper used by per-node bundles.
 * Scope: Exports CORE_TOOL_BUNDLE (source of truth), TOOL_CATALOG (derived view), and createToolCatalog. Does NOT import @langchain, does NOT contain node-only tools (those live in nodes/<node>/packages/ai-tools/).
 * Invariants:
 *   - CORE_BUNDLE_IS_CANONICAL: CORE_TOOL_BUNDLE is the single hand-maintained list; TOOL_CATALOG derives from it.
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
 * CORE_TOOL_BUNDLE: cross-node core tool bundle. Single source of truth for the
 * `core__` tools shared by every node.
 *
 * Each node's bootstrap imports this directly:
 *   - Non-poly nodes: `createBoundToolSource([...CORE_TOOL_BUNDLE], toolBindings)`
 *   - Poly node: `createBoundToolSource([...CORE_TOOL_BUNDLE, ...POLY_TOOL_BUNDLE], toolBindings)`
 *     where POLY_TOOL_BUNDLE comes from @cogni/poly-ai-tools.
 *
 * Adding a new core tool (shared by all nodes): append the BoundTool here.
 * Adding a node-only tool (e.g. poly-only): add it to that node's
 * `nodes/<node>/packages/ai-tools/` package instead — never here.
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
  vcsCreateBranchBoundTool as CatalogBoundTool,
  vcsFlightCandidateBoundTool as CatalogBoundTool,
  vcsGetCiStatusBoundTool as CatalogBoundTool,
  vcsListPrsBoundTool as CatalogBoundTool,
  vcsMergePrBoundTool as CatalogBoundTool,
  webSearchBoundTool as CatalogBoundTool,
  workItemQueryBoundTool as CatalogBoundTool,
  workItemTransitionBoundTool as CatalogBoundTool,
];

/**
 * TOOL_CATALOG: id-keyed view of CORE_TOOL_BUNDLE.
 *
 * Derived from CORE_TOOL_BUNDLE so the two never drift. Consumed by
 * `@cogni/langgraph-graphs/runtime/{core/make-server-graph,cogni/make-cogni-graph}`
 * which look core tools up by ID for the FAIL_FAST_ON_MISSING_TOOLS invariant.
 *
 * Per TOOL_ID_STABILITY: duplicate IDs throw at construction time (inside
 * createToolCatalog).
 *
 * Node-only tool catalogs (e.g. POLY_TOOL_BUNDLE in @cogni/poly-ai-tools) do not
 * appear here. Each runtime composes the catalog it needs from per-node bundles.
 */
export const TOOL_CATALOG: ToolCatalog = createToolCatalog(CORE_TOOL_BUNDLE);

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
