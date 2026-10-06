// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: Static-roster drift guard for `@adapters/server/node-registry/network-nodes.data`.
 * Purpose: Keep every committed fallback node honest against its identity SSoT without requiring new
 *   wizard nodes to rewrite compiled operator source. The runtime composes this preserved static subset
 *   with the DB projection that owns dynamic wizard nodes. This test re-reads the SSoT at TEST time and
 *   asserts every static entry matches its catalog projection on every field:
 *     - `name`  ← an existing catalog `type: node` row (a stale removed node fails).
 *     - `primary` ← the catalog's `is_primary_host` (task.5078 — operator serves the bare apex domain;
 *        every other node uses `${name}-${DOMAIN}`). A hand-flipped/stale `primary` now fails here.
 *     - `nodeId` ← the identity SSoT per `REPO_SPEC_IS_IDENTITY_SSOT` (infra/catalog/_schema.json): a
 *        SUBMODULE node (`source_repo` set) carries a drift-gated `node_id` PROJECTION in its catalog
 *        row; an IN-REPO node (e.g. operator) carries it in `nodes/<slug>/.cogni/repo-spec.yaml` and
 *        must NOT duplicate it in the catalog. This test reads from the correct source per node.
 *   New catalog nodes need not appear here: forcing catalog equality made node.register.v1 author
 *   executable TypeScript. Static entries remain strict; dynamic membership comes from the DB.
 * Scope: Reads `infra/catalog/*.yaml` + in-repo `nodes/<slug>/.cogni/repo-spec.yaml` from disk; pure-data
 *   assertion otherwise. No network.
 * Side-effects: fs reads under the repo's infra/catalog + nodes/<slug>/.cogni.
 * Links: src/adapters/server/node-registry/network-nodes.data.ts, infra/catalog/*.yaml,
 *   infra/catalog/_schema.json (REPO_SPEC_IS_IDENTITY_SSOT), docs/spec/ci-cd.md (task.5078),
 *   src/adapters/server/node-registry/db-node-registry.adapter.ts (dynamic membership)
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NETWORK_NODES } from "@/adapters/server/node-registry/network-nodes.data";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/unit/adapters/node-registry → repo root is six levels up (operator app is nodes/operator/app).
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..");
const CATALOG_DIR = path.join(REPO_ROOT, "infra", "catalog");

/** The identity projection the roster MUST mirror, derived from the SSoT for one catalog `type: node`. */
interface ExpectedNode {
  readonly name: string;
  readonly nodeId: string;
  readonly primary: boolean;
}

/**
 * Resolve a node's `node_id` from the identity SSoT per REPO_SPEC_IS_IDENTITY_SSOT:
 *   submodule (`source_repo` set) → the catalog row's drift-gated `node_id` projection;
 *   in-repo → `nodes/<slug>/.cogni/repo-spec.yaml` (the catalog must NOT duplicate it).
 */
function resolveNodeId(
  slug: string,
  catalogDoc: { node_id?: string; source_repo?: string }
): string {
  if (catalogDoc.source_repo) {
    if (!catalogDoc.node_id) {
      throw new Error(
        `catalog/${slug}.yaml is a submodule node (source_repo set) but carries no node_id projection`
      );
    }
    return catalogDoc.node_id;
  }
  const specPath = path.join(
    REPO_ROOT,
    "nodes",
    slug,
    ".cogni",
    "repo-spec.yaml"
  );
  const spec = parse(readFileSync(specPath, "utf8")) as { node_id?: string };
  if (!spec.node_id) {
    throw new Error(
      `in-repo node '${slug}' has no node_id in nodes/${slug}/.cogni/repo-spec.yaml`
    );
  }
  return spec.node_id;
}

/** Build the expected roster projection straight from the identity SSoT (catalog + repo-specs). */
function expectedRoster(): ExpectedNode[] {
  const nodes: ExpectedNode[] = [];
  for (const file of readdirSync(CATALOG_DIR)) {
    if (!file.endsWith(".yaml") || file.startsWith("_")) continue;
    const doc = parse(readFileSync(path.join(CATALOG_DIR, file), "utf8")) as {
      name?: string;
      type?: string;
      node_id?: string;
      source_repo?: string;
      is_primary_host?: boolean;
    };
    if (doc?.type !== "node" || !doc.name) continue;
    nodes.push({
      name: doc.name,
      nodeId: resolveNodeId(doc.name, doc),
      primary: doc.is_primary_host === true,
    });
  }
  return nodes;
}

/** Normalize a committed roster entry to the same shape (undefined primary ⇒ false). */
function normalizeRosterEntry(entry: {
  name: string;
  nodeId?: string;
  primary?: boolean;
}): ExpectedNode {
  if (!entry.nodeId) {
    throw new Error(`roster entry '${entry.name}' is missing nodeId`);
  }
  return {
    name: entry.name,
    nodeId: entry.nodeId,
    primary: entry.primary === true,
  };
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

describe("adapters/node-registry/network-nodes.data ↔ identity SSoT drift", () => {
  it("static roster is a field-exact subset of the catalog projection", () => {
    const expectedByName = new Map(
      expectedRoster().map((node) => [node.name, node])
    );
    const roster = NETWORK_NODES.map(normalizeRosterEntry).sort(byName);

    // New wizard nodes are DB-projected and may be absent here. Every preserved fallback entry must
    // still exist in the SSoT and match its nodeId/primary values exactly.
    for (const node of roster) {
      expect(expectedByName.get(node.name)).toEqual(node);
    }
  });

  it("exactly one node is primary (serves the bare apex domain — task.5078)", () => {
    // is_primary_host is the catalog SSoT; the roster must reflect exactly one apex node.
    expect(expectedRoster().filter((n) => n.primary)).toHaveLength(1);
    expect(NETWORK_NODES.filter((n) => n.primary === true)).toHaveLength(1);
  });

  it("excludes infra-only catalog entries (litellm/openfga/scheduler-worker have no web tier)", () => {
    const rosterSlugs = new Set(NETWORK_NODES.map((n) => n.name));
    for (const infraOnly of ["litellm", "openfga", "scheduler-worker"]) {
      expect(rosterSlugs.has(infraOnly)).toBe(false);
    }
  });

  it("the catalog actually exists and is non-trivial (sanity: the fs path resolved)", () => {
    expect(expectedRoster().length).toBeGreaterThanOrEqual(2);
  });
});
