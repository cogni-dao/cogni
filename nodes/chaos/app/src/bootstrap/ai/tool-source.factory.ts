// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/ai/tool-source.factory`
 * Purpose: Create StaticToolSource with real implementations from bindings.
 * Scope: Factory for tool source port. Does NOT execute tools.
 * Invariants:
 *   - TOOL_BINDING_REQUIRED: Every contract in the supplied list must have a binding
 *   - OPEN_WORLD_CONTRACTS: Caller supplies the contract list; factory is not
 *     coupled to TOOL_CATALOG. Each node passes its own bundle
 *     (e.g. [...CORE_TOOL_BUNDLE, ...POLY_TOOL_BUNDLE]) so non-poly nodes never
 *     need stubs for tools they don't own.
 *   - IMPLEMENTATIONS_FROM_BINDINGS: Uses implementations from tool-bindings
 * Side-effects: none
 * Links: TOOL_USE_SPEC.md, container.ts
 * @internal
 */

import { createStaticToolSource, type StaticToolSource } from "@cogni/ai-core";
import { type CatalogBoundTool, contractToRuntime } from "@cogni/ai-tools";

import type { ToolBindings } from "./tool-bindings";

/**
 * Create a StaticToolSource with real implementations from bindings.
 *
 * Per OPEN_WORLD_CONTRACTS: the caller supplies `contracts` — an explicit list
 * of CatalogBoundTool entries. The factory does not consult TOOL_CATALOG; each
 * node determines its own tool surface at the composition root (container.ts).
 *
 * Per TOOL_BINDING_REQUIRED: Every tool in `contracts` must have a
 * corresponding binding. Missing bindings throw at startup to fail fast.
 *
 * @param contracts - Ordered list of bound tools this node exposes
 * @param bindings - Tool bindings map from createToolBindings()
 * @returns StaticToolSource with the supplied tools wired to real implementations
 * @throws Error if any contract tool is missing a binding
 */
export function createBoundToolSource(
  contracts: readonly CatalogBoundTool[],
  bindings: ToolBindings
): StaticToolSource {
  const runtimes = [];

  for (const boundTool of contracts) {
    const toolId = boundTool.contract.name;
    const impl = bindings[toolId];
    if (!impl) {
      throw new Error(
        `TOOL_BINDING_REQUIRED: Missing implementation binding for tool "${toolId}". ` +
          `Add binding in src/bootstrap/ai/tool-bindings.ts`
      );
    }
    runtimes.push(contractToRuntime(boundTool.contract, impl));
  }

  return createStaticToolSource(runtimes);
}
