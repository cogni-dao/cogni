// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/evaluation-baseline`
 * Purpose: Bind published mission-loop contracts while preserving operator authorization metadata.
 * Scope: Node-owned composition only; no copied tool implementations or graph prompts.
 * Invariants:
 *   - HOST_POLICY_PRESERVED: every replaced contract keeps its existing operator requires gate.
 *   - RELEASE_OWNS_BEHAVIOR: the six baseline tool schemas come from the immutable tools release.
 *   - OTHER_TOOLS_UNCHANGED: product/VCS tools retain their existing bindings and runtime policy.
 * Side-effects: none
 * Links: hub adopt-node-package-release, story.5111
 * @internal
 */

import { type CatalogBoundTool, CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { CORE_TOOL_BUNDLE as SHARED_TOOL_BUNDLE } from "@cogni/shared-ai-tools";

const baselineIds = new Set([
  "core__goal_list",
  "core__work_item_query",
  "core__work_item_transition",
  "core__knowledge_search",
  "core__edo_decide",
  "core__get_current_time",
]);
const sharedById = new Map(
  SHARED_TOOL_BUNDLE.map((tool) => [tool.contract.name, tool])
);

export const OPERATOR_CORE_TOOL_BUNDLE: readonly CatalogBoundTool[] =
  CORE_TOOL_BUNDLE.map((local) => {
    if (!baselineIds.has(local.contract.name)) return local;
    const shared = sharedById.get(local.contract.name);
    if (!shared)
      throw new Error(`Missing shared evaluation tool: ${local.contract.name}`);
    if (local.contract.requires === undefined) {
      throw new Error(
        `Missing operator policy for shared evaluation tool: ${local.contract.name}`
      );
    }
    return {
      ...shared,
      contract: { ...shared.contract, requires: local.contract.requires },
    };
  });
