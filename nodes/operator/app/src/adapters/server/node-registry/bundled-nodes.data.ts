// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/bundled-nodes.data`
 * Purpose: Operator's curated, shipped showcase nodes (those with committed homepage screenshots).
 *   The StaticNodeRegistryAdapter source; composed with the DB projection for dynamic nodes.
 * Scope: Static data only — no IO, no env. `name` matches infra/catalog/<name>.yaml.
 * Invariants: `primary` true means the node serves the bare base domain (operator). `thumbnail` is a
 *   committed screenshot under public/showcase/.
 * Side-effects: none
 * Notes: Dynamic/new nodes flow via the DB projection, not here — this stays a small curated bundle.
 * Links: public/showcase/*.png, src/adapters/server/node-registry/static-node-registry.adapter.ts
 * @public
 */

export interface ShowcaseNode {
  /** Catalog name (infra/catalog/<name>.yaml). Used to derive the node host. */
  name: string;
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

/** Showcased nodes, in display order. Curate freely — copy is intentionally editable. */
export const SHOWCASE_NODES: readonly ShowcaseNode[] = [
  {
    name: "operator",
    title: "Cogni Operator",
    tagline: "The AI git-manager that launches and runs community-owned nodes.",
    thumbnail: "/showcase/operator.png",
    primary: true,
  },
  {
    name: "resy",
    title: "Resy Helper",
    tagline: "Claims restaurant reservations in seconds, beating scalper bots.",
    thumbnail: "/showcase/resy.png",
  },
  {
    name: "canary",
    title: "Canary",
    tagline:
      "An autonomous AI node — governed on-chain, ships its own pull requests.",
    thumbnail: "/showcase/canary.png",
  },
  {
    name: "node-template",
    title: "Launch your own",
    tagline: "Fork this starter to spin up your own community-owned AI app.",
    thumbnail: "/showcase/node-template.png",
  },
];
