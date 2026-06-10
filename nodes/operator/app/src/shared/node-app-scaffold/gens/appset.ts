// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/appset`
 * Purpose: Pure port of `scripts/ci/render-node-appset.sh` — emit a new node's per-`(env, slug)` Argo
 *   ApplicationSet objects and register them in the bootstrap kustomization, so the operator can author
 *   a node-formation PR without bash. One AppSet object per `(env, node)` is the structural LANE_ISOLATION
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

/**
 * Canonical env render order — byte-exact to `render-node-appset.sh`'s
 * `ENVS=(candidate-a preview production)`. The block must always re-render in
 * this order regardless of the new node's birth envs (task.5017): a node born
 * into a subset must NOT drop the preview/production members of OTHER nodes.
 */
const RENDER_ENVS = ["candidate-a", "preview", "production"] as const;

/**
 * Parse the GENERATED block into per-env node-sets (task.5017). Preserving which
 * nodes are in which env block is load-bearing now that the node-set is per-env:
 * the old union-then-cartesian flattening re-inflated every env to every node.
 */
function existingNodesByEnv(
  blockLines: readonly string[]
): Map<string, Set<string>> {
  const byEnv = new Map<string, Set<string>>(
    RENDER_ENVS.map((env) => [env, new Set<string>()])
  );
  for (const line of blockLines) {
    const envNode = line.match(/^ {2}- (.+)-applicationset\.yaml$/)?.[1];
    if (envNode === undefined) continue;
    for (const env of RENDER_ENVS) {
      if (envNode.startsWith(`${env}-`)) {
        byEnv.get(env)?.add(envNode.slice(env.length + 1));
        break;
      }
    }
  }
  return byEnv;
}

/**
 * Fold `<slug>` into the GENERATED node-appsets block of `infra/k8s/argocd/kustomization.yaml`,
 * adding it ONLY to the envs in its per-env node-set (`envs`), re-rendering env-major +
 * node-sorted (LC_ALL=C order ≡ ASCII codepoint sort for kebab slugs), byte-exact to
 * `render-node-appset.sh`'s `render_kustomization_block`. Idempotent.
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

  const byEnv = existingNodesByEnv(lines.slice(begin + 1, end));
  if (envs.every((env) => byEnv.get(env)?.has(slug))) {
    return currentKustomization;
  }
  for (const env of envs) {
    byEnv.get(env)?.add(slug);
  }

  const block: string[] = [];
  for (const env of RENDER_ENVS) {
    for (const node of [...(byEnv.get(env) ?? [])].sort()) {
      block.push(`  - ${env}-${node}-applicationset.yaml`);
    }
  }

  return [...lines.slice(0, begin + 1), ...block, ...lines.slice(end)].join(
    "\n"
  );
}
