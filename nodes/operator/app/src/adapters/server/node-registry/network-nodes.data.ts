// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/network-nodes.data`
 * Purpose: The committed, typed roster of the operator's deployed WEB nodes — the full network roster
 *   that seeds the public gallery's CANDIDATE set. This mirrors the deploy catalog's web-serving nodes
 *   (`infra/catalog/<name>.yaml` with `type: node`), which the operator runtime image CANNOT fs-glob
 *   (the image ships only its own `.cogni`, not `infra/catalog/`). So the catalog roster is hand-lifted
 *   into this typed module and kept honest by a drift-guard unit test that re-reads the catalog at TEST
 *   time and fails if the two ever diverge.
 * Scope: Static data only — no IO, no env. Each `name` matches `infra/catalog/<name>.yaml`. Infra-only
 *   catalog entries (`type: infra`/`service`: litellm, openfga, scheduler-worker) are EXCLUDED — they
 *   have no public web tier so they can never be a gallery card.
 * Invariants:
 *   - CATALOG_IS_SSOT: this roster's slug set MUST equal the catalog's `type: node` set. The drift test
 *     (`tests/unit/adapters/node-registry/network-nodes-catalog-drift.test.ts`) enforces it; add a node
 *     to the catalog ⇒ the test fails until it is added here too.
 *   - CANDIDATE_NOT_SHOWCASE: an entry here is only a CANDIDATE — it shows in the gallery iff its prod
 *     host is verified-live (LiveNodeRegistryAdapter). A down/never-promoted node is filtered out with
 *     no code edit, so this roster can list the whole deployed network without lying.
 *   - PRIMARY_SERVES_APEX: `primary: true` marks the node serving the bare base domain (operator).
 *   - THUMBNAIL_IS_OPTIONAL: only nodes with a committed `public/showcase/<name>.png` set `thumbnail`;
 *     the rest degrade to NodeTile's branded monogram placeholder (never a broken image).
 * Side-effects: none
 * Links: infra/catalog/*.yaml (the SSoT this mirrors), public/showcase/*.png,
 *   src/adapters/server/node-registry/static-node-registry.adapter.ts,
 *   src/adapters/server/node-registry/live-node-registry.adapter.ts,
 *   tests/unit/adapters/node-registry/network-nodes-catalog-drift.test.ts
 * @public
 */

/** A deployed web node in the network roster. `name` matches `infra/catalog/<name>.yaml`. */
export interface NetworkNode {
  /** Catalog name (`infra/catalog/<name>.yaml`). Used to derive the node host. */
  name: string;
  /** Deployment UUID from the operator repo-spec nodes[] registry, when shipped. */
  nodeId?: string;
  /** Display title for the tile. */
  title: string;
  /** One-line pitch, drawn from the node's own homepage. */
  tagline: string;
  /** Committed homepage screenshot served from public/ (e.g. "/showcase/operator.png"). Omit to fall
   *  back to the branded monogram placeholder. */
  thumbnail?: string;
  /** Absolute homepage URL. Omit to derive `<name>-<baseDomain>` from APP_BASE_URL. */
  url?: string;
  /** True for the node that serves the bare base domain (operator). */
  primary?: boolean;
}

/**
 * The full deployed web-node roster, in display order. This is the gallery's CANDIDATE set — each entry
 * is shown ONLY if its production host is verified-live (LiveNodeRegistryAdapter ∩ live-prod), so a
 * down/decommissioned node is hidden with no code edit. The slug set is pinned to the catalog's
 * `type: node` entries by the drift test; copy/order is freely editable.
 *
 * Thumbnails: only operator / node-template have a committed `public/showcase/*.png` today (the curated
 * `resy` screenshot was retired with the dead `resy` node). The rest render NodeTile's monogram
 * placeholder — intentional, branded, never a broken image.
 */
export const NETWORK_NODES: readonly NetworkNode[] = [
  {
    name: "operator",
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    title: "Cogni Operator",
    tagline: "The AI git-manager that launches and runs community-owned nodes.",
    thumbnail: "/showcase/operator.png",
    primary: true,
  },
  {
    name: "node-template",
    nodeId: "b927a9dd-6132-4fc9-a51e-e3cee2568e3c",
    title: "Launch your own",
    tagline: "Fork this starter to spin up your own community-owned AI app.",
    thumbnail: "/showcase/node-template.png",
  },
  {
    name: "beacon",
    nodeId: "f97f68f2-8406-4a3b-b5a9-d579b779f19d",
    title: "Beacon",
    tagline: "A community-owned AI node, built on Cogni.",
  },
  {
    name: "blue",
    nodeId: "da3777a6-1f33-463a-a73c-70924806da50",
    title: "Blue",
    tagline: "A community-owned AI node, built on Cogni.",
  },
  {
    name: "habitat",
    nodeId: "dbf1eeb7-85d4-4fd5-a4fe-da85c668bb03",
    title: "Habitat",
    tagline: "A community-owned AI node, built on Cogni.",
  },
  {
    name: "oss",
    nodeId: "4d7ffb44-fc26-4a55-864f-eff9fbc8aba1",
    title: "OSS",
    tagline: "A community-owned AI node, built on Cogni.",
  },
  {
    name: "red",
    nodeId: "895147d5-2ad9-4b2b-aeaa-f2669999fdce",
    title: "Red",
    tagline: "A community-owned AI node, built on Cogni.",
  },
  {
    name: "games",
    nodeId: "baa9148e-3245-4f7d-976b-292fd049ca38",
    title: "Games",
    tagline: "A community-owned AI node, built on Cogni.",
  },
];
