// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/catalog`
 * Purpose: Pure port of `scaffold-node.sh` step 4 — render a new node's `infra/catalog/<slug>.yaml`
 *   from the `node-template.yaml` shape, so the operator can author a node-birth PR without bash/sed.
 * Scope: Given a `slug` + container `port` + `node_port`, emit a `type:node` catalog entry valid per
 *   `infra/catalog/_schema.json`, with all `node-template`-derived fields renamed to `slug`.
 * Invariants: REPO_SPEC_IS_IDENTITY_SSOT — NO `node_id` (the schema forbids it; identity lives in
 *   `.cogni/repo-spec.yaml`). CATALOG_IS_SSOT — fields mirror the committed `canary.yaml` shape.
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: infra/catalog/node-template.yaml, infra/catalog/_schema.json, scripts/setup/scaffold-node.sh, task.5092
 * @public
 */

/**
 * Render `infra/catalog/<slug>.yaml` for a new `type:node` entry. `port` is the container port (3200
 * on the template); `nodePort` is the scarce k3s Service NodePort. No `node_id` (schema-forbidden).
 */
export interface RenderCatalogInput {
  readonly sourceRepo?: string;
  readonly imageRepository?: string;
}

function defaultImageRepository(sourceRepo: string): string {
  const match = sourceRepo.match(/^https:\/\/github\.com\/([^/]+)\//);
  const owner = match?.[1]?.toLowerCase() ?? "cogni-dao";
  return `ghcr.io/${owner}/cogni-node-template`;
}

export function renderCatalog(
  slug: string,
  port: number,
  nodePort: number,
  input: RenderCatalogInput = {}
): string {
  const sourceLines = input.sourceRepo
    ? `source_repo: ${input.sourceRepo}
image_repository: ${input.imageRepository ?? defaultImageRepository(input.sourceRepo)}
`
    : "";
  return `name: ${slug}
type: node
port: ${port}
node_port: ${nodePort}
dockerfile: nodes/${slug}/app/Dockerfile
image_tag_suffix: "-${slug}"
migrator_tag_suffix: "-${slug}-migrate"
${sourceLines}candidate_a_branch: deploy/candidate-a-${slug}
preview_branch: deploy/preview-${slug}
production_branch: deploy/production-${slug}
path_prefix: nodes/${slug}/
`;
}
