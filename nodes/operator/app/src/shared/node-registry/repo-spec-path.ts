// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-registry/repo-spec-path`
 * Purpose: Derive where a catalog node's `.cogni/repo-spec.yaml` lives, for the `nodes.repo_spec_path` projection.
 * Scope: Pure function over two catalog-row fields. No IO, no env.
 * Invariants:
 *   - SOURCE_REPO_SPEC_AT_ROOT: a row with `source_repo` keeps its repo-spec at `.cogni/repo-spec.yaml`
 *     in that repo (toks5, poly, red).
 *   - IN_REPO_SPEC_UNDER_PATH_PREFIX: a row without `source_repo` keeps it at
 *     `<path_prefix>.cogni/repo-spec.yaml` in the parent repo (the operator). Same rule as the
 *     formation writer and the catalog lister's node-id read.
 *   - The repo itself is NOT returned: `nodes.repo_owner`/`repo_name` already name it (the
 *     `source_repo` owner/name, else the parent).
 * Side-effects: none
 * Links: infra/catalog/_schema.json, src/adapters/server/vcs/github-repo-write.ts, task.5494
 * @public
 */

export interface CatalogRepoSpecPathInput {
  readonly source_repo?: string | undefined;
  /** Catalog `path_prefix`, with trailing slash (`nodes/operator/`). */
  readonly path_prefix: string;
}

export function deriveCatalogRepoSpecPath(
  row: CatalogRepoSpecPathInput
): string {
  if (row.source_repo) return ".cogni/repo-spec.yaml";
  return `${row.path_prefix}.cogni/repo-spec.yaml`;
}
