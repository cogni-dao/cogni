// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/static-node-registry.adapter`
 * Purpose: NodeRegistryPort adapter for operator's curated, shipped showcase nodes (the ones with
 *   committed homepage screenshots). Composed with the DB-projection adapter for dynamic nodes.
 * Scope: Maps bundled full-app nodes → NodeSummary, resolving hrefs from a base domain. Pure: the
 *   domain is injected (no env access here); the server factory supplies it.
 * Invariants: every bundled node is `kind: "full-app"`; href via the catalog host convention.
 * Side-effects: none
 * Links: src/ports/node-registry.port.ts, src/shared/node-registry/resolve.ts
 * @public
 */

import type { NodeRegistryPort, NodeSummary } from "@/ports";
import { resolveHref } from "@/shared/node-registry/resolve";

import { SHOWCASE_NODES, type ShowcaseNode } from "./bundled-nodes.data";

function toSummary(
  node: ShowcaseNode,
  domain: string | undefined
): NodeSummary {
  return {
    slug: node.name,
    ...(node.nodeId !== undefined && { nodeId: node.nodeId }),
    title: node.title,
    tagline: node.tagline,
    kind: "full-app",
    repo: {
      owner: "Cogni-DAO",
      name: node.name === "operator" ? "cogni" : node.name,
      url:
        node.name === "operator"
          ? "https://github.com/Cogni-DAO/cogni"
          : `https://github.com/Cogni-DAO/${node.name}`,
    },
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
