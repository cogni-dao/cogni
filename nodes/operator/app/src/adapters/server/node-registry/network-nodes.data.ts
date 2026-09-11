// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/network-nodes.data`
 * Purpose: The committed, typed ROSTER of the operator's deployed WEB nodes — slug + deployment id +
 *   primary flag ONLY. This is the catalog membership list the gallery probes; it carries ZERO display
 *   identity (no title/tagline/thumbnail). Each card's title/tagline/thumbnail/color is read at runtime
 *   from the node's OWN `/.well-known/agent.json` identity (a repo-spec projection), so a node customizes
 *   its gallery card by editing its repo-spec — never operator code. This roster mirrors the deploy
 *   catalog's web-serving nodes (`infra/catalog/<name>.yaml` with `type: node`), which the operator
 *   runtime image CANNOT fs-glob (it ships only its own `.cogni`, not `infra/catalog/`), so the slug set
 *   is hand-lifted and kept honest by a drift-guard unit test that re-reads the catalog at TEST time.
 * Scope: Static data only — no IO, no env, NO display literals. Each `name` matches
 *   `infra/catalog/<name>.yaml`. Infra-only catalog entries (`type: infra`/`service`: litellm, openfga,
 *   scheduler-worker) are EXCLUDED — they have no public web tier so they can never be a gallery card.
 * Invariants:
 *   - CATALOG_IS_SSOT: this roster is a PROJECTION of the identity SSoT, guarded on EVERY field (not just
 *     slugs) by the TOTAL drift test (`tests/unit/adapters/node-registry/
 *     network-nodes-catalog-drift.test.ts`): `name` ← catalog `type: node` set; `primary` ← catalog
 *     `is_primary_host`; `nodeId` ← catalog `node_id` (submodule) or `nodes/<slug>/.cogni/repo-spec.yaml`
 *     (in-repo), per `REPO_SPEC_IS_IDENTITY_SSOT` (infra/catalog/_schema.json). Any drift on any field
 *     fails the test. Publish keeps it green automatically via the `insertNetworkNode` splice.
 *   - NO_OPERATOR_IDENTITY_LITERALS: this module holds NO title/tagline/thumbnail. Identity comes from the
 *     node's well-known projection at runtime (resolveNodeLiveness). The operator never names a node.
 *   - PRIMARY_SERVES_APEX (task.5078; docs/spec/ci-cd.md axiom 16): `primary: true` marks the single node
 *     serving the bare base domain (`https://${DOMAIN}` — operator); every other node is served at
 *     `${name}-${DOMAIN}`. It mirrors the catalog's `is_primary_host: true` (the SSoT).
 * Side-effects: none
 * Links: infra/catalog/*.yaml (the SSoT this mirrors),
 *   src/adapters/server/node-registry/static-node-registry.adapter.ts (roster → NodeSummary skeleton),
 *   src/adapters/server/node-registry/live-node-registry.adapter.ts (merges identity+health onto it),
 *   src/app/.well-known/agent.json/route.ts (the per-node identity projection),
 *   tests/unit/adapters/node-registry/network-nodes-catalog-drift.test.ts
 * @public
 */

/**
 * A deployed web node in the network roster. `name` matches `infra/catalog/<name>.yaml`. Carries NO
 * display identity — title/tagline/thumbnail/color are read from the node's own well-known at runtime.
 */
export interface NetworkNode {
  /** Catalog name (`infra/catalog/<name>.yaml`). Used to derive the node host. */
  name: string;
  /** Deployment UUID from the operator repo-spec nodes[] registry, when shipped. */
  nodeId?: string;
  /** True for the node that serves the bare base domain (operator). */
  primary?: boolean;
}

/**
 * The full deployed web-node roster, in display order. This is the gallery's candidate set: each slug is
 * probed for liveness + self-described identity (resolveNodeLiveness). The roster carries ONLY catalog
 * membership — slug, deployment id, and the primary flag — because the operator holds zero per-node
 * identity. The slug set is pinned to the catalog's `type: node` entries by the drift test.
 */
export const NETWORK_NODES: readonly NetworkNode[] = [
  {
    name: "operator",
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    primary: true,
  },
  { name: "node-template", nodeId: "b927a9dd-6132-4fc9-a51e-e3cee2568e3c" },
  { name: "beacon", nodeId: "f97f68f2-8406-4a3b-b5a9-d579b779f19d" },
  { name: "poly", nodeId: "4b06359a-a859-4399-888e-a8c7a6696f7e" },
  { name: "toks4", nodeId: "72aa130b-f0ad-495a-a061-9ee1f9c9525d" },
  { name: "levelup", nodeId: "557d8b59-8e3b-42f0-9aeb-a5c171296556" },
];
