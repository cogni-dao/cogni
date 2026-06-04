// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/showcase/static-node-registry.adapter`
 * Purpose: v0 NodeRegistryPort adapter backed by the curated static showcase list. The port seam so
 *   the homepage depends on a contract, not the raw data — the DB-projection adapter (v0.1) drops in
 *   behind the same interface.
 * Scope: Maps curated full-app nodes → NodeSummary, resolving hrefs from a base domain. Pure: the
 *   domain is injected (no env access here); the server factory supplies it.
 * Invariants: every showcased v0 node is `kind: "full-app"`; href via the catalog host convention.
 * Side-effects: none
 * Links: src/ports/node-registry.port.ts, src/features/home/showcase/nodes.resolve.ts
 * @public
 */

import type { NodeRegistryPort, NodeSummary } from "@/ports/node-registry";

import { SHOWCASE_NODES, type ShowcaseNode } from "./nodes.data";
import { resolveHref } from "./nodes.resolve";

function toSummary(
  node: ShowcaseNode,
  domain: string | undefined
): NodeSummary {
  return {
    slug: node.name,
    title: node.title,
    tagline: node.tagline,
    kind: "full-app",
    href: resolveHref(node, domain),
    thumbnailUrl: node.thumbnail,
    primary: node.primary,
  };
}

/** Serves the curated v0 full-app nodes. Replaced by a DB-projection adapter in v0.1. */
export class StaticNodeRegistryAdapter implements NodeRegistryPort {
  constructor(
    private readonly nodes: readonly ShowcaseNode[] = SHOWCASE_NODES,
    private readonly domain: string | undefined = undefined
  ) {}

  listPublic(): Promise<readonly NodeSummary[]> {
    return Promise.resolve(
      this.nodes.map((node) => toSummary(node, this.domain))
    );
  }
}
