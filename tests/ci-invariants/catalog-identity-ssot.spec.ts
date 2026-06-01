// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/catalog-identity-ssot`
 * Purpose: Pins REPO_SPEC_IS_IDENTITY_SSOT — node identity (`node_id`) is declared
 *          ONLY in `nodes/<name>/.cogni/repo-spec.yaml` (the web3-anchored authority),
 *          never duplicated in `infra/catalog/*.yaml`. The billing/routing CSVs in
 *          `scripts/ci/lib/image-tags.sh` resolve `node_id` from repo-spec.
 * Scope: Static structural test that reads catalog + repo-spec files. No shell-out.
 * Invariants:
 *   NO_CATALOG_NODE_ID: no catalog entry may carry a `node_id` key (deploy-shape ≠ identity).
 *   EVERY_NODE_HAS_REPO_SPEC_ID: every `type: node` catalog entry has a repo-spec with a UUID `node_id`.
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
  node_id?: unknown;
}

function listCatalogEntries(): { file: string; entry: CatalogEntry }[] {
  return readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => ({
      file,
      entry: yaml.parse(readFileSync(path.join(CATALOG_DIR, file), "utf8")) as CatalogEntry,
    }));
}

describe("catalog identity SSOT (REPO_SPEC_IS_IDENTITY_SSOT)", () => {
  const entries = listCatalogEntries();

  it("no catalog entry declares node_id (identity lives in repo-spec, not the catalog)", () => {
    const offenders = entries
      .filter(({ entry }) => Object.hasOwn(entry, "node_id"))
      .map(({ file }) => file);
    expect(
      offenders,
      `infra/catalog/${offenders.join(", ")} must NOT declare node_id — it is sourced ` +
        "from nodes/<name>/.cogni/repo-spec.yaml. Remove the catalog node_id.",
    ).toEqual([]);
  });

  it("every type:node entry has a repo-spec with a UUID node_id", () => {
    for (const { file, entry } of entries) {
      if (entry.type !== "node") continue;
      const prefix = entry.path_prefix ?? `nodes/${entry.name}/`;
      const specPath = path.join(REPO_ROOT, prefix, ".cogni/repo-spec.yaml");
      const spec = yaml.parse(readFileSync(specPath, "utf8")) as { node_id?: string };
      expect(
        spec.node_id,
        `${specPath} (declared by catalog ${file}) must define a node_id`,
      ).toBeDefined();
      expect(
        spec.node_id,
        `${specPath} node_id must be a UUID`,
      ).toMatch(UUID);
    }
  });
});
