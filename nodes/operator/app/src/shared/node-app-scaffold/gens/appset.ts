// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/appset`
 * Purpose: Pure port of `scripts/ci/render-node-appset.sh` — emit a new node's per-`(env, slug)` Argo
 *   ApplicationSet objects and register them in the bootstrap kustomization, so the operator can author
 *   a node-birth PR without bash. One AppSet object per `(env, node)` is the structural LANE_ISOLATION
 *   fix (`bug.0378`): a flight only ever applies its own node's file.
 * Scope: `renderNodeAppset` substitutes the shared template (the SAME file the shell renderer feeds, so
 *   output is byte-exact and the `--check` drift gate stays green); `insertAppsetKustomization` re-renders
 *   the GENERATED sentinel block with the new slug folded in (env-major, node-sorted, mirroring the shell).
 * Invariants: BYTE_EXACT_WITH_RENDERER — token substitution + block ordering match `render-node-appset.sh`.
 *   IDEMPOTENT — a kustomization already listing the slug is returned unchanged.
 * Side-effects: none — pure string transforms, no IO, no env.
 * Links: scripts/ci/render-node-appset.sh, scripts/ci/node-applicationset.yaml.tmpl, bug.0378, task.5092
 * @public
 */

/** Sentinels delimiting the generated node-appset list in `infra/k8s/argocd/kustomization.yaml`. */
const KUSTOMIZATION_BEGIN =
  "  # >>> GENERATED node-appsets (scripts/ci/render-node-appset.sh) — DO NOT EDIT BY HAND";
const KUSTOMIZATION_END = "  # <<< GENERATED node-appsets";

/**
 * Substitute the per-`(env, slug)` ApplicationSet template, byte-exact to the shell renderer's
 * `sed -e s/__ENV__/…/g -e s/__NODE__/…/g`. Argo `{{.name}}` goTemplate markers are left intact.
 */
export function renderNodeAppset(
  template: string,
  slug: string,
  env: string
): string {
  return template.replaceAll("__ENV__", env).replaceAll("__NODE__", slug);
}

/** Extract the deployable node slugs already listed in the generated block (across all birth envs). */
function existingNodes(
  blockLines: readonly string[],
  envs: readonly string[]
): string[] {
  const nodes = new Set<string>();
  for (const line of blockLines) {
    const match = line.match(/^ {2}- (.+)-applicationset\.yaml$/);
    const envNode = match?.[1];
    if (envNode === undefined) continue;
    for (const env of envs) {
      if (envNode.startsWith(`${env}-`)) {
        nodes.add(envNode.slice(env.length + 1));
        break;
      }
    }
  }
  return [...nodes];
}

/**
 * Fold `<slug>` into the GENERATED node-appsets block of `infra/k8s/argocd/kustomization.yaml`,
 * re-rendering it env-major + node-sorted (LC_ALL=C order ≡ ASCII codepoint sort for kebab slugs),
 * byte-exact to `render-node-appset.sh`'s `render_kustomization_block`. Idempotent.
 */
export function insertAppsetKustomization(
  currentKustomization: string,
  slug: string,
  envs: readonly string[]
): string {
  const lines = currentKustomization.split("\n");
  const begin = lines.indexOf(KUSTOMIZATION_BEGIN);
  const end = lines.indexOf(KUSTOMIZATION_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      "infra/k8s/argocd/kustomization.yaml is missing the GENERATED node-appsets sentinels; cannot splice."
    );
  }

  const nodes = existingNodes(lines.slice(begin + 1, end), envs);
  if (nodes.includes(slug)) {
    return currentKustomization;
  }

  const sorted = [...nodes, slug].sort();
  const block: string[] = [];
  for (const env of envs) {
    for (const node of sorted) {
      block.push(`  - ${env}-${node}-applicationset.yaml`);
    }
  }

  return [...lines.slice(0, begin + 1), ...block, ...lines.slice(end)].join(
    "\n"
  );
}
