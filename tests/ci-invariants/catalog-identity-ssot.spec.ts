// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/catalog-identity-ssot`
 * Purpose: Pins REPO_SPEC_IS_IDENTITY_SSOT — `node_id` authority lives in `nodes/<name>/.cogni/repo-spec.yaml`. In-repo rows read it directly; a submodule row (`source_repo` set, repo-spec unreadable from the parent) carries a drift-gated `node_id` PROJECTION in the catalog so `image-tags.sh`'s routing/billing CSVs resolve identity (verify-scheduler-endpoints asserts they match).
 * Scope: Static structural test that reads catalog + repo-spec files; does not shell out, build, or hit the network.
 * Invariants:
 *   IN_REPO_NODE_NO_CATALOG_NODE_ID: a row without `source_repo` must NOT carry `node_id` — identity stays in repo-spec.
 *   SUBMODULE_NODE_HAS_CATALOG_NODE_ID: a row with `source_repo` must carry a UUID `node_id` projection.
 *   EVERY_INLINE_NODE_HAS_REPO_SPEC_ID: every inline `type: node` catalog entry has a repo-spec
 *     with a UUID `node_id`; submodule pins are external identities.
 * Side-effects: IO (reads infra/catalog/*.yaml and nodes/<name>/.cogni/repo-spec.yaml)
 * Links: scripts/ci/lib/image-tags.sh, infra/catalog/_schema.json, docs/spec/ci-cd.md (axiom 16),
 *        docs/spec/billing-evolution.md, ROADMAP.md ("Repo-Spec Authority")
 * @public
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CATALOG_DIR = path.join(REPO_ROOT, "infra/catalog");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CatalogEntry {
  name: string;
  type: "node" | "service";
  path_prefix?: string;
  source_repo?: unknown;
  node_id?: unknown;
}

function listCatalogEntries(): { file: string; entry: CatalogEntry }[] {
  return readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => ({
      file,
      entry: yaml.parse(
        readFileSync(path.join(CATALOG_DIR, file), "utf8")
      ) as CatalogEntry,
    }));
}

describe("catalog identity SSOT (REPO_SPEC_IS_IDENTITY_SSOT)", () => {
  const entries = listCatalogEntries();

  it("in-repo rows (no source_repo) do not declare node_id (identity lives in repo-spec)", () => {
    const offenders = entries
      .filter(({ entry }) => !Object.hasOwn(entry, "source_repo"))
      .filter(({ entry }) => Object.hasOwn(entry, "node_id"))
      .map(({ file }) => file);
    expect(
      offenders,
      `infra/catalog/${offenders.join(", ")} must NOT declare node_id — an in-repo node's ` +
        "identity is sourced from nodes/<name>/.cogni/repo-spec.yaml. Remove the catalog node_id."
    ).toEqual([]);
  });

  it("submodule rows (source_repo set) carry a UUID node_id projection", () => {
    const missing = entries
      .filter(({ entry }) => Object.hasOwn(entry, "source_repo"))
      .filter(({ entry }) => !UUID.test(String(entry.node_id ?? "")))
      .map(({ file }) => file);
    expect(
      missing,
      `infra/catalog/${missing.join(", ")} (submodule rows) must declare a UUID node_id — ` +
        "the drift-gated projection of the parent-unreadable repo-spec node_id."
    ).toEqual([]);
  });

  it("every inline type:node entry has a repo-spec with a UUID node_id", () => {
    for (const { file, entry } of entries) {
      if (entry.type !== "node") continue;
      // Remote-source nodes (source_repo set) live in their own repo — no
      // in-parent repo-spec; their identity is the catalog node_id projection
      // (asserted above). Only inline nodes carry a parent repo-spec.
      if (Object.hasOwn(entry, "source_repo")) continue;
      const prefix = entry.path_prefix ?? `nodes/${entry.name}/`;
      const specPath = path.join(REPO_ROOT, prefix, ".cogni/repo-spec.yaml");
      const spec = yaml.parse(readFileSync(specPath, "utf8")) as {
        node_id?: string;
      };
      expect(
        spec.node_id,
        `${specPath} (declared by catalog ${file}) must define a node_id`
      ).toBeDefined();
      expect(spec.node_id, `${specPath} node_id must be a UUID`).toMatch(UUID);
    }
  });
});
