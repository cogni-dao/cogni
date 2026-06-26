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
  /** Deployment identity when known. Used to join derived ledger metrics. */
  readonly nodeId?: string | undefined;
  /**
   * Display title — the node's NAME (`titleCase` of its `intent.name`/slug). NEVER an operator-side
   * literal, and NEVER the hook or mission (which are supporting copy).
   */
  readonly title: string;
  /**
   * Short pitch — the node's own `intent.hook`, read from its `/.well-known/agent.json` identity.
   * Empty string when undeclared (no operator literal). `mission` carries the longer repo-spec blurb.
   */
  readonly tagline: string;
  /** Repo-spec `intent.mission`, when the node projects it through its well-known identity. */
  readonly mission?: string | undefined;
  readonly kind: NodeKind;
  /** Source repository identity when known. */
  readonly repo?: {
    readonly owner: string;
    readonly name: string;
    readonly url: string;
  };
  /** Resolved homepage URL (subdomain for full-app; scope-route for agent-scope), or "#". */
  readonly href: string;
  /**
   * Absolute, host-resolved homepage thumbnail from the node's own `intent.brand.thumbnail`; undefined
   * for nodes without a shipped thumbnail (tile shows a brand-tinted monogram placeholder).
   */
  readonly thumbnailUrl?: string | undefined;
  /**
   * Lucide icon NAME (PascalCase) from the node's own `intent.brand.icon` — the SSOT for the card mark.
   * The gallery renders this big + brand-tinted, in preference to a thumbnail. Undefined → monogram.
   */
  readonly icon?: string | undefined;
  /** Monogram-tint brand color from the node's own `intent.brand.color`; undefined falls back to a token. */
  readonly brandColor?: string | undefined;
  /**
   * Production/env liveness from the cached probe. `undefined` when liveness is unknown (e.g. local dev
   * with no base domain, where the gallery skips probing). The operator OWNS displaying this — down nodes
   * are NOT hidden.
   */
  readonly health?: "live" | "down" | undefined;
  /** True for the node that serves the bare base domain (operator). */
  readonly primary?: boolean | undefined;
}

/** Read-model registry of discoverable nodes. */
export interface NodeRegistryPort {
  /** Public, non-owner-scoped list of nodes for discovery surfaces. */
  listPublic(): Promise<readonly NodeSummary[]>;
}
