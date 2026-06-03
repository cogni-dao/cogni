// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/showcase/nodes.data`
 * Purpose: Curated source of truth for the homepage node showcase. Each entry becomes a tile.
 * Scope: Static data only — no IO, no env. Adding a node to the monorepo = add an entry here.
 *   href resolution + env coupling live in getShowcaseNodes.server.ts.
 * Invariants: `name` must match the node's infra/catalog/<name>.yaml entry; `primary` true means
 *   the node serves the bare base domain (operator). Mirrors CATALOG_IS_SSOT naming.
 * Side-effects: none
 * Notes: v0 source is this typed module (infra/catalog/*.yaml is not present in the runtime image —
 *   COGNI_REPO_PATH=/app only ships operator's .cogni). Refine path: codegen this from the catalog.
 * Links: infra/catalog/_schema.json, src/features/home/showcase/getShowcaseNodes.server.ts
 * @public
 */

export type ShowcaseCategory = "platform" | "app" | "hub";
export type ShowcaseAccent = "blue" | "emerald" | "amber" | "rose";

export interface ShowcaseNode {
  /** Catalog name (infra/catalog/<name>.yaml). Used to derive the node host. */
  name: string;
  /** Display title for the tile. */
  title: string;
  /** One-line pitch. */
  tagline: string;
  /** Tile taxonomy — drives the icon + badge. */
  category: ShowcaseCategory;
  /** Gradient banner accent (semantic-token keyed). */
  accent: ShowcaseAccent;
  /** Absolute homepage URL. Omit to derive `<name>-<baseDomain>` from APP_BASE_URL. */
  url?: string;
  /** True for the node that serves the bare base domain (operator). */
  primary?: boolean;
}

/**
 * Showcased nodes, in display order. Curate freely — copy is intentionally editable.
 * Featured node apps + the fork-me template. Operator (the platform) is the host, not a tile.
 */
export const SHOWCASE_NODES: readonly ShowcaseNode[] = [
  {
    name: "resy",
    title: "Resy Helper",
    tagline: "A conversational concierge for finding and booking tables.",
    category: "app",
    accent: "blue",
  },
  {
    name: "canary",
    title: "Canary",
    tagline: "The always-on node that proves the autonomous build loop.",
    category: "app",
    accent: "emerald",
  },
  {
    name: "node-template",
    title: "Node Template",
    tagline: "Fork this to launch your own community-owned AI app.",
    category: "hub",
    accent: "amber",
  },
];
