// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/node-registry`
 * Purpose: Read-model port for discovering Cogni nodes (the unified node registry the homepage and
 *   future browse/sort UI consume). One contract; adapters back it by different sources.
 * Scope: Discovery/read only. Does not form, deploy, or mutate nodes.
 * Invariants:
 *   - UI_ONLY_TALKS_TO_PORT: consumers call listPublic() via the port; never the underlying source.
 *   - PROJECTION_NOT_SSOT: returned data is a read model; git specs / wizard DB are authoritative.
 *   - KIND_MIRRORS_TOPOLOGY: `kind` reflects node-operator-contract topology (`full-app` vs
 *     `agent-scope`); a `full-app` href is a subdomain, an `agent-scope` href is a scope-route.
 *     Graduation between kinds is invisible to consumers.
 * Side-effects: none (interface only)
 * Links: work/projects/proj.agent-registry.md (Node Registry Track), docs/spec/node-operator-contract.md
 * @public
 */

/**
 * Node topology surfaced as a read-model discriminator (node-operator-contract.md):
 * - `full-app`: own node_id + DB + deploy; homepage is a subdomain.
 * - `agent-scope`: an agent bundle + Dolt + DAO running as a scope inside a host node; homepage is a
 *   route within the host node's app. Graduates to `full-app` only on data/deploy/fork sovereignty.
 */
export type NodeKind = "full-app" | "agent-scope";

/** A node as shown in discovery surfaces (homepage tiles, future browse/sort). */
export interface NodeSummary {
  /** Stable display key (catalog name for monorepo nodes, slug for wizard nodes). */
  readonly slug: string;
  readonly title: string;
  readonly tagline: string;
  readonly kind: NodeKind;
  /** Resolved homepage URL (subdomain for full-app; scope-route for agent-scope), or "#". */
  readonly href: string;
  /** Homepage screenshot/preview served from public/ or a screenshot source. */
  readonly thumbnailUrl: string;
  /** True for the node that serves the bare base domain (operator). */
  readonly primary?: boolean;
  /** Governance/deployment identity, when known (sourced from repo-spec, never minted here). */
  readonly nodeId?: string;
}

/** Read-model registry of discoverable nodes. */
export interface NodeRegistryPort {
  /** Public, non-owner-scoped list of nodes for discovery surfaces. */
  listPublic(): Promise<readonly NodeSummary[]>;
}
