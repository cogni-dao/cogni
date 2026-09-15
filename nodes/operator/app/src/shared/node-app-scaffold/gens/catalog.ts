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
 * Links: infra/catalog/node-template.yaml, infra/catalog/_schema.json, scripts/setup/scaffold-node.sh,
 *   task.5092, story.5025, task.5097, task.5104
 * @public
 */

import { hasCrossplaneControlPlane } from "@/shared/node-registry/crossplane-control-plane";

import { NODE_FORMATION_ACTIVITY_ENV, NODE_FORMATION_ENVS } from "./envs";

/**
 * Render `infra/catalog/<slug>.yaml` for a new `type:node` entry. `port` is the container port (3200
 * on the template); `nodePort` is the scarce k3s Service NodePort. No `node_id` (schema-forbidden).
 */
export interface RenderCatalogInput {
  /** Stable cross-environment owner binding; each env resolves its own users.id from this wallet. */
  readonly ownerWallet: string;
  readonly sourceRepo?: string;
  readonly imageRepository?: string;
  /** Remote-source node identity, projected from the minted repo-spec (drift-gated). */
  readonly nodeId?: string;
  /**
   * Accepted deploy SHA for a remote-source node — the catalog pin that replaces the
   * `nodes/<slug>` gitlink (spec.node-submodule-retirement, CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN).
   * Affected-flight detection + sourceSha resolution read this; the operator bumps it per flight.
   */
  readonly sourceSha?: string;
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
  input: RenderCatalogInput
): string {
  // BORN_ON_AKASH (story.5025) — placement is stated, never defaulted. The pre-existing
  // `?? "k3s"` fallback is for rows minted before decentralized compute existed; a node born
  // today is off-cluster in every environment it is born into, and says so in git.
  // AKASH_NEEDS_BUILD_PLANE — both keys are schema-gated on `source_repo`, because the
  // off-cluster lane resolves an immutable artifact from an external build plane. An in-repo
  // row has none, so it stays on the pre-existing k3s/legacy default rather than emitting a
  // catalog the schema would reject. Every wizard birth is a fork, so every birth is akash.
  const offCluster = Boolean(input.sourceRepo);
  const envs = NODE_FORMATION_ENVS;
  const placementBlock = offCluster
    ? `deployment_provider:\n${envs.map((env) => `  ${env}: akash\n`).join("")}`
    : "";
  // AUTHORITY_REQUIRES_AN_INSTALLED_API (task.5104) — placement and compute authority are
  // DIFFERENT AXES, so they are filtered differently. Every birth env is genuinely `akash`
  // above; only the envs that carry a Crossplane control plane can name `crossplane` here.
  // Naming it for production would commit an XComputeWorkload into a cluster with no such CRD
  // (no crossplane-* Application exists under infra/k8s/argocd/control-plane/production/), so
  // the promote would render a workload nothing reconciles. The unfiltered envs stay on the
  // pre-existing `legacy` default until their control plane is installed and
  // CROSSPLANE_CONTROL_PLANE_ENVS is widened — at which point births pick it up automatically.
  const crossplaneEnvs = envs.filter((env) => hasCrossplaneControlPlane(env));
  const computeApiBlock =
    offCluster && crossplaneEnvs.length > 0
      ? `compute_api:\n${crossplaneEnvs.map((env) => `  ${env}: crossplane\n`).join("")}`
      : "";
  const sourceShaLine = input.sourceSha
    ? `source_sha: ${input.sourceSha}\n`
    : "";
  const sourceLines = input.sourceRepo
    ? `source_repo: ${input.sourceRepo}
image_repository: ${input.imageRepository ?? imageRepositoryFromSourceRepo(input.sourceRepo)}
${sourceShaLine}`
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
# story.5025 — per-env node-set (deploy ⊆ provisioned). A wizard birth renders the transient
# candidate-a proof slot and canonical production; PREVIEW_IS_ABSENT_AT_BIRTH. Closing the
# candidate after the proof is the ordinary env verb ({env:candidate-a, present:false}).
envs: [${envs.join(", ")}]
# story.5025 — BORN_ON_AKASH. Placement is stated at birth, never inherited from the k3s
# fallback that exists for rows minted before decentralized compute did.
${placementBlock}# task.5097 — WHICH authority reconciles the workload. Crossplane
# (infra/crossplane/xcomputeworkload) owns every generic concern; the only Cogni-specific
# piece left is the private Akash transaction actuator. A born node never touches the
# bespoke controller in any environment whose control plane can reconcile the composite; an
# environment without one is omitted and stays on the pre-existing legacy default (task.5104).
${computeApiBlock}# story.5025 — birth authority is PRODUCTION, the only environment that receives Git
# webhooks (ACTIVITY_FOLLOWS_INGEST, bug.5079). Born here it is immutable for life: a
# sub-production authority would have to be moved by every later promote, and generation 1
# has no fenced cross-environment cutover. candidate-a stays passive — it never ingests, so
# it can never run a competing activity ledger.
activity_env: ${NODE_FORMATION_ACTIVITY_ENV}
# Stable binding only; the reconciler resolves an env-local users.id by wallet.
owner_wallet: "${input.ownerWallet}"
path_prefix: nodes/${slug}/
${nodeIdLine}`;
}
