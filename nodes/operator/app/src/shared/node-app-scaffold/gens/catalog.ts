// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/catalog`
 * Purpose: Pure port of `scaffold-node.sh` step 4 — render a new node's `infra/catalog/<slug>.yaml`
 *   from the `node-template.yaml` shape, so the operator can author a node-formation PR without bash/sed.
 * Scope: Given a `slug` + container `port` + `node_port`, emit a `type:node` catalog entry valid per
 *   `infra/catalog/_schema.json`, with all `node-template`-derived fields renamed to `slug`.
 * Invariants: REPO_SPEC_IS_IDENTITY_SSOT — `.cogni/repo-spec.yaml` is the identity source. A
 *   submodule node's repo-spec is unreadable from the parent at render time, so the catalog carries a
 *   drift-gated `node_id` PROJECTION (verify-scheduler-endpoints asserts it == repo-spec). The mint
 *   generates both from one node_id, so they cannot drift at birth. CATALOG_IS_SSOT — fields mirror
 *   the committed shape.
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
  /** Submodule node identity, projected from the minted repo-spec (drift-gated). */
  readonly nodeId?: string;
}

function imageRepositoryFromSourceRepo(sourceRepo: string): string {
  const url = new URL(sourceRepo);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(`sourceRepo must be a GitHub HTTPS URL: ${sourceRepo}`);
  }

  const [ownerPart, repoPart, ...extraParts] = url.pathname
    .split("/")
    .filter(Boolean);
  const repoName = repoPart?.replace(/\.git$/, "");
  if (!ownerPart || !repoName || extraParts.length > 0) {
    throw new Error(
      `sourceRepo must be https://github.com/<owner>/<repo>: ${sourceRepo}`
    );
  }

  const owner = ownerPart.toLowerCase();
  const repo = repoName.toLowerCase();
  return `ghcr.io/${owner}/${repo}`;
}

export function renderCatalog(
  slug: string,
  port: number,
  nodePort: number,
  input: RenderCatalogInput = {}
): string {
  const sourceLines = input.sourceRepo
    ? `source_repo: ${input.sourceRepo}
image_repository: ${input.imageRepository ?? imageRepositoryFromSourceRepo(input.sourceRepo)}
`
    : "";
  const nodeIdLine = input.nodeId ? `node_id: ${input.nodeId}\n` : "";
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
# task.5017 — per-env node-set (deploy ⊆ provisioned). A wizard birth enters all
# NODE_FORMATION_ENVS; this list is the catalog twin so render-node-appset.sh
# renders exactly the births appset.ts generates. Trimming a node's reach is a
# later catalog edit (drop an env here) once its envs are provisioned.
envs: [candidate-a, preview, production]
path_prefix: nodes/${slug}/
${nodeIdLine}`;
}
