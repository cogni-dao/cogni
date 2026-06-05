// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/composite-node-registry.adapter`
 * Purpose: NodeRegistryPort that fans out to child registries and merges by slug (earlier children
 *   win). Lets the homepage compose operator's bundled curated nodes with the live DB projection
 *   behind one port.
 * Scope: Pure composition over injected child ports. No IO of its own.
 * Invariants: child order = precedence (bundled before dynamic → curated entries win on slug clash).
 * Side-effects: none
 * Links: src/ports/node-registry.port.ts, src/shared/node-registry/resolve.ts
 * @public
 */

import type { NodeRegistryPort, NodeSummary } from "@/ports";
import { mergeBySlug } from "@/shared/node-registry/resolve";

export class CompositeNodeRegistryAdapter implements NodeRegistryPort {
  constructor(private readonly children: readonly NodeRegistryPort[]) {}

  async listPublic(): Promise<readonly NodeSummary[]> {
    const lists = await Promise.all(this.children.map((c) => c.listPublic()));
    return mergeBySlug(...lists);
  }
}
