// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/static-node-registry.adapter`
 * Purpose: NodeRegistryPort adapter for the operator's committed network roster — the full set of
 *   deployed web nodes (the catalog `type: node` entries). Composed with the DB-projection adapter for
 *   wizard-created dynamic nodes.
 * Scope: Maps roster full-app nodes → NodeSummary, resolving hrefs from a base domain. Pure: the
 *   domain is injected (no env access here); the server factory supplies it.
 * Invariants: every roster node is `kind: "full-app"`; href via the catalog host convention.
 * Side-effects: none
 * Links: src/ports/node-registry.port.ts, src/shared/node-registry/resolve.ts,
 *   src/adapters/server/node-registry/network-nodes.data.ts
 * @public
 */

import type { NodeRegistryPort, NodeSummary } from "@/ports";
import { resolveHref } from "@/shared/node-registry/resolve";

import { NETWORK_NODES, type NetworkNode } from "./network-nodes.data";

function toSummary(node: NetworkNode, domain: string | undefined): NodeSummary {
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

/** Serves the committed network roster of full-app web nodes (catalog `type: node`). */
export class StaticNodeRegistryAdapter implements NodeRegistryPort {
  constructor(
    private readonly nodes: readonly NetworkNode[] = NETWORK_NODES,
    private readonly domain: string | undefined = undefined
  ) {}

  listPublic(): Promise<readonly NodeSummary[]> {
    return Promise.resolve(
      this.nodes.map((node) => toSummary(node, this.domain))
    );
  }
}
