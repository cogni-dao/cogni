// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/static-node-registry.adapter`
 * Purpose: NodeRegistryPort adapter for the operator's committed network roster — the full set of
 *   deployed web nodes (the catalog `type: node` entries). Composed with the DB-projection adapter for
 *   wizard-created dynamic nodes.
 * Scope: Maps roster full-app nodes → a NodeSummary SKELETON (slug, repo, href, primary), resolving hrefs
 *   from a base domain. It supplies NO display identity: `title` defaults to `titleCaseSlug(slug)` and
 *   `tagline` to "" — both are OVERWRITTEN downstream by the LiveNodeRegistryAdapter from each node's own
 *   well-known identity. Pure: the domain is injected (no env access here); the server factory supplies it.
 * Invariants:
 *   - NO_IDENTITY_LITERALS: this adapter never names a node; title/tagline here are pure fallbacks.
 *   - every roster node is `kind: "full-app"`; href via the catalog host convention.
 * Side-effects: none
 * Links: src/ports/node-registry.port.ts, src/shared/node-registry/resolve.ts,
 *   src/adapters/server/node-registry/network-nodes.data.ts,
 *   src/adapters/server/node-registry/live-node-registry.adapter.ts (overwrites title/tagline from identity)
 * @public
 */

import type { NodeRegistryPort, NodeSummary } from "@/ports";
import { resolveHref, titleCaseSlug } from "@/shared/node-registry/resolve";

import { NETWORK_NODES, type NetworkNode } from "./network-nodes.data";

function toSummary(node: NetworkNode, domain: string | undefined): NodeSummary {
  return {
    slug: node.name,
    ...(node.nodeId !== undefined && { nodeId: node.nodeId }),
    // Fallback identity only — the LiveNodeRegistryAdapter overwrites title/tagline from the node's own
    // well-known `intent`. A node not yet projecting identity keeps this titleCase(slug) / empty tagline.
    title: titleCaseSlug(node.name),
    tagline: "",
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
