// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/overlay`
 * Purpose: Pure port of `scaffold-node.sh` step 5 — clone the `node-template` per-env
 *   `kustomization.yaml` into a new node's overlay, so the operator can author a node-birth PR
 *   without `cp -R` + sed on a checkout.
 * Scope: Given the CURRENT committed `infra/k8s/overlays/<env>/node-template/kustomization.yaml`
 *   and the new node's `slug` + `nodePort` + container `port`, return the overlay byte-identical to
 *   what `cp -R` + the scaffold's two `perl` rewrites emit. Env-specific content (namespace,
 *   externalName, NEXTAUTH host) rides along from the source overlay unchanged.
 * Invariants: SCAFFOLD_OUTPUT_PARITY — mirrors the shell's `s/node-template/<slug>/g` then
 *   `s/\b30200\b/<nodePort>/g; s/\b3200\b/<port>/g`. NodePort 30200 → `nodePort`; container 3200 →
 *   `port`. No drift-gate on overlays, so exact-match-to-canary is not required — only valid +
 *   consistent with the scaffold.
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: scripts/setup/scaffold-node.sh, infra/k8s/overlays, task.5092
 * @public
 */

const TEMPLATE_SLUG = "node-template";

/**
 * Clone the node-template overlay for one env into the new node's overlay. `templateOverlay` is the
 * source `infra/k8s/overlays/<env>/node-template/kustomization.yaml`; the env identity is carried by
 * that content (no substitution needed). Rewrites slug + the two well-known port literals only.
 */
export function renderOverlay(
  templateOverlay: string,
  slug: string,
  nodePort: number,
  port: number,
  options: { readonly secretTargetName?: string } = {}
): string {
  // Mirror scaffold-node.sh: rename slug first, then the word-bounded port literals (30200 must be
  // rewritten before 3200 so the `\b30200\b` match is not shadowed by a naive `3200` substring).
  const renamed = templateOverlay.split(TEMPLATE_SLUG).join(slug);
  const ported = renamed
    .replace(/\b30200\b/g, String(nodePort))
    .replace(/\b3200\b/g, String(port));
  if (!options.secretTargetName) return ported;
  return ported
    .split(`${slug}-node-app-secrets`)
    .join(options.secretTargetName);
}
