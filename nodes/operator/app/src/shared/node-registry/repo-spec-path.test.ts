// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-registry/repo-spec-path.test`
 * Purpose: Pin `repo_spec_path` derivation against the REAL catalog rows, not invented shapes.
 * Scope: Reads `infra/catalog/toks5.yaml` (source_repo node) and `infra/catalog/operator.yaml` (in-repo node).
 * Invariants: SOURCE_REPO_SPEC_AT_ROOT, IN_REPO_SPEC_UNDER_PATH_PREFIX.
 * Side-effects: IO (reads two files from the repository checkout).
 * Links: src/shared/node-registry/repo-spec-path.ts, task.5494
 * @internal
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { deriveCatalogRepoSpecPath } from "./repo-spec-path";

// src/shared/node-registry -> repo root (operator app is nodes/operator/app).
const REPO_ROOT = resolve(__dirname, "../../../../../../");

function catalogRow(slug: string): {
  source_repo?: string;
  path_prefix: string;
} {
  return parseYaml(
    readFileSync(resolve(REPO_ROOT, `infra/catalog/${slug}.yaml`), "utf8")
  ) as { source_repo?: string; path_prefix: string };
}

describe("deriveCatalogRepoSpecPath", () => {
  it("a source_repo node (toks5) keeps its repo-spec at the root of its own repo", () => {
    const row = catalogRow("toks5");
    expect(row.source_repo).toBe("https://github.com/cogni-dao/toks5.git");
    expect(deriveCatalogRepoSpecPath(row)).toBe(".cogni/repo-spec.yaml");
  });

  it("an in-repo node (operator) keeps its repo-spec under its path_prefix in the parent", () => {
    const row = catalogRow("operator");
    expect(row.source_repo).toBeUndefined();
    expect(deriveCatalogRepoSpecPath(row)).toBe(
      "nodes/operator/.cogni/repo-spec.yaml"
    );
  });
});
