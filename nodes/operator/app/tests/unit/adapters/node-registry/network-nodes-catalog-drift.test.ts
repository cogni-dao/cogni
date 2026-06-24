// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: drift guard for `@adapters/server/node-registry/network-nodes.data`.
 * Purpose: Keep the committed web-node roster honest against the deploy catalog. The operator runtime
 *   image ships only its own `.cogni` (NOT `infra/catalog/`), so the roster is hand-lifted from the
 *   catalog and CANNOT be fs-globbed at runtime. This unit test re-reads `infra/catalog/*.yaml` at TEST
 *   time (where a repo fs-read is fine) and asserts the roster's slug set EXACTLY equals the catalog's
 *   web-serving (`type: node`) node set — so adding a node to the catalog fails this test until the
 *   roster is updated, and an infra-only entry (`type: infra`/`service`) can never silently leak in.
 * Scope: Reads the repo's `infra/catalog/*.yaml` from disk; pure-data assertion otherwise. No network.
 * Side-effects: fs reads under the repo's infra/catalog.
 * Links: src/adapters/server/node-registry/network-nodes.data.ts, infra/catalog/*.yaml
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

/** Read the catalog's web-serving node slugs (`type: node`) straight from disk. */
function catalogWebNodeSlugs(): Set<string> {
  const slugs = new Set<string>();
  for (const file of readdirSync(CATALOG_DIR)) {
    if (!file.endsWith(".yaml") || file.startsWith("_")) continue;
    const doc = parse(readFileSync(path.join(CATALOG_DIR, file), "utf8")) as {
      name?: string;
      type?: string;
    };
    if (doc?.type === "node" && doc.name) slugs.add(doc.name);
  }
  return slugs;
}

describe("adapters/node-registry/network-nodes.data ↔ infra/catalog drift", () => {
  it("roster slug set EXACTLY equals the catalog's type:node (web-serving) set", () => {
    const catalog = [...catalogWebNodeSlugs()].sort();
    const roster = [...new Set(NETWORK_NODES.map((n) => n.name))].sort();

    // Asserting equality (not subset) is the guardrail: a node added to the catalog OR removed from it
    // fails this test until the committed roster is brought back in sync.
    expect(roster).toEqual(catalog);
  });

  it("excludes infra-only catalog entries (litellm/openfga/scheduler-worker have no web tier)", () => {
    const rosterSlugs = new Set(NETWORK_NODES.map((n) => n.name));
    for (const infraOnly of ["litellm", "openfga", "scheduler-worker"]) {
      expect(rosterSlugs.has(infraOnly)).toBe(false);
    }
  });

  it("the catalog actually exists and is non-trivial (sanity: the fs path resolved)", () => {
    expect(catalogWebNodeSlugs().size).toBeGreaterThanOrEqual(2);
  });
});
