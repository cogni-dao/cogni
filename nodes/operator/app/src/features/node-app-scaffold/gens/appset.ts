// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-app-scaffold/gens/appset`
 * Purpose: Pure port of `scaffold-node.sh` step 6 — splice a new node's git-generator stanza into a
 *   committed `infra/k8s/argocd/<env>-applicationset.yaml`, so the operator can author a node-birth
 *   PR without `perl -0pi`.
 * Scope: Given the CURRENT committed ApplicationSet YAML + the new node's `slug` + `env`, insert the
 *   5-line `- git:` generator block (revision `deploy/<env>-<slug>`, file `infra/catalog/<slug>.yaml`)
 *   immediately before the `  template:` line, byte-identical to the shell renderer.
 * Invariants: STANZA_BEFORE_TEMPLATE — the block lands ahead of the first `  template:` line, in the
 *   generators list. IDEMPOTENT — a YAML already referencing `infra/catalog/<slug>.yaml` is returned
 *   unchanged (mirrors the shell's `grep -q … && continue`).
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: scripts/setup/scaffold-node.sh, infra/k8s/argocd, task.5092
 * @public
 */

/** The 5-line git-generator stanza for `<env>/<slug>`, matching the committed AppSet shape. */
function stanza(slug: string, env: string): string {
  return [
    "    - git:",
    "        repoURL: https://github.com/cogni-dao/cogni.git",
    `        revision: deploy/${env}-${slug}`,
    "        files:",
    `          - path: "infra/catalog/${slug}.yaml"`,
  ].join("\n");
}

/**
 * Insert the `<slug>` git-generator stanza before the `  template:` line of `<env>`'s ApplicationSet.
 * Idempotent: returns the input unchanged if it already references `infra/catalog/<slug>.yaml`.
 */
export function insertAppsetStanza(
  currentAppset: string,
  slug: string,
  env: string
): string {
  if (currentAppset.includes(`infra/catalog/${slug}.yaml`)) {
    return currentAppset;
  }

  const lines = currentAppset.split("\n");
  const templateIdx = lines.findIndex((l) => l === "  template:");
  if (templateIdx === -1) {
    throw new Error(
      `ApplicationSet for env '${env}' is missing a top-level 'template:' line; cannot splice.`
    );
  }

  const block = stanza(slug, env).split("\n");
  return [
    ...lines.slice(0, templateIdx),
    ...block,
    ...lines.slice(templateIdx),
  ].join("\n");
}
