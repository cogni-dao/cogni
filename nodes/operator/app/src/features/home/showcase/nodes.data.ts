// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/showcase/nodes.data`
 * Purpose: Curated source of truth for the homepage node showcase. Each entry becomes a tile.
 * Scope: Static data only — no IO, no env. Adding a node to the monorepo = add an entry here
 *   (+ a thumbnail under public/showcase/). href resolution lives in getShowcaseNodes.server.ts.
 * Invariants: `name` matches the node's infra/catalog/<name>.yaml entry; `primary` true means the
 *   node serves the bare base domain (operator). `thumbnail` is a screenshot of the node's homepage.
 * Side-effects: none
 * Notes: Thumbnails are committed screenshots of each live homepage. Refine path: per-node
 *   `opengraph-image` routes or a build-time screenshot job so thumbnails self-update.
 * Links: public/showcase/*.png, src/features/home/showcase/getShowcaseNodes.server.ts
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
