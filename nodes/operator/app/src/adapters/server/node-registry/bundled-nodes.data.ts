// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/bundled-nodes.data`
 * Purpose: Operator's curated CANDIDATE nodes — the in-image catalog nodes that have no wizard DB row
 *   (operator, plus shipped full-app catalog nodes with committed homepage screenshots). This is a
 *   CANDIDATE set, NOT a showcase: it is composed with the DB projection and then INTERSECTED with the
 *   cached prod-liveness snapshot (LiveNodeRegistryAdapter), so a dead/decommissioned catalog node never
 *   reaches the gallery. Curate freely — liveness, not this list, decides what ships.
 * Scope: Static data only — no IO, no env. `name` matches infra/catalog/<name>.yaml.
 * Invariants:
 *   - PRIMARY_SERVES_APEX: `primary: true` means the node serves the bare base domain (operator).
 *   - THUMBNAIL_IS_PRESENTATION: `thumbnail` is a committed screenshot under public/showcase/; a node
 *     without one degrades to the NodeTile gradient placeholder (never a broken image).
 *   - LIVENESS_GATES_DISPLAY: an entry here is only a CANDIDATE; it shows iff its prod host is live.
 *     Decommissioned nodes (e.g. the removed `canary`) must be deleted here too — a dead candidate is
 *     pure noise even though the liveness filter would also drop it.
 * Side-effects: none
 * Notes: Dynamic/wizard nodes flow via the DB projection, not here — this stays a small curated bundle.
 * Links: public/showcase/*.png, src/adapters/server/node-registry/static-node-registry.adapter.ts,
 *   src/adapters/server/node-registry/live-node-registry.adapter.ts
 * @public
 */

export interface ShowcaseNode {
  /** Catalog name (infra/catalog/<name>.yaml). Used to derive the node host. */
  name: string;
  /** Deployment UUID from the operator repo-spec nodes[] registry, when shipped. */
  nodeId?: string;
  /** Display title for the tile. */
  title: string;
  /** One-line pitch, drawn from the node's own homepage. */
  tagline: string;
  /** Homepage screenshot served from public/ (e.g. "/showcase/resy.png"). */
  thumbnail: string;
  /** Absolute homepage URL. Omit to derive `<name>-<baseDomain>` from APP_BASE_URL. */
  url?: string;
  /** True for the node that serves the bare base domain (operator). */
  primary?: boolean;
}

/**
 * Curated candidate nodes, in display order. Each is shown ONLY if its production host is verified-live
 * (LiveNodeRegistryAdapter). Curate freely — copy is intentionally editable. Delete decommissioned
 * nodes here rather than relying on the liveness filter to hide a dead tile's noise.
 */
export const SHOWCASE_NODES: readonly ShowcaseNode[] = [
  {
    name: "operator",
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    title: "Cogni Operator",
    tagline: "The AI git-manager that launches and runs community-owned nodes.",
    thumbnail: "/showcase/operator.png",
    primary: true,
  },
  {
    name: "resy",
    nodeId: "f6d2a17d-b7f6-4ad1-a86b-f0ad2380999e",
    title: "Resy Helper",
    tagline: "Claims restaurant reservations in seconds, beating scalper bots.",
    thumbnail: "/showcase/resy.png",
  },
  {
    name: "node-template",
    title: "Launch your own",
    tagline: "Fork this starter to spin up your own community-owned AI app.",
    thumbnail: "/showcase/node-template.png",
  },
];
