// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/overlay`
 * Purpose: Pure port of `scaffold-node.sh` step 5 — clone the `node-template` per-env
 *   `kustomization.yaml` into a new node's overlay, so the operator can author a node-birth PR
 *   without `cp -R` + sed on a checkout.
 * Scope: Given the CURRENT committed `infra/k8s/overlays/<env>/node-template/kustomization.yaml`
 *   and the new node's `slug` + `nodePort` + container `port`, return the overlay byte-identical to
 *   what `cp -R` + the scaffold's rewrites emit. Env-specific content (namespace, externalName,
 *   NEXTAUTH host) rides along from the source overlay unchanged.
 * Invariants:
 *   - SCAFFOLD_OUTPUT_PARITY — mirrors the shell's `s/node-template/<slug>/g` then
 *     `s/\b30200\b/<nodePort>/g; s/\b3200\b/<port>/g`. NodePort 30200 → `nodePort`; container 3200 →
 *     `port`. No drift-gate on overlays, so exact-match-to-canary is not required — only valid +
 *     consistent with the scaffold.
 *   - NODE_AT_ROOT_MIGRATE_PATH — wizard-born nodes ship node-at-root images whose app tree is at
 *     `/app/app`, not the monorepo `/app/nodes/<slug>/app` the shared base Deployment assumes. The
 *     generated overlay rewrites the Doltgres runner path and injects the Postgres migrate override
 *     so both initContainer migrate commands run the node's OWN migrations from its OWN image layout.
 *     This is what lets a sovereign node evolve its DB schema without an operator code edit.
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: scripts/setup/scaffold-node.sh, docs/spec/node-baas-architecture.md, infra/k8s/overlays,
 *   task.5092
 * @public
 */

const TEMPLATE_SLUG = "node-template";

/** Node-at-root standalone image app root. See NODE_AT_ROOT_MIGRATE_PATH. */
const STANDALONE_APP_DIR = "/app/app";

const MONOREPO_APP_DIR_RE = /\/app\/nodes\/\$\(NODE_NAME\)\/app/g;

const MIGRATE_SECRET_ANCHOR_RE =
  / {8}path: \/spec\/template\/spec\/initContainers\/0\/envFrom\/1\/secretRef\/name\n {8}value: [^\n]*\n/;

const POSTGRES_MIGRATE_OVERRIDE =
  "      - op: replace\n" +
  "        path: /spec/template/spec/initContainers/0/command/2\n" +
  `        value: exec node ${STANDALONE_APP_DIR}/migrate.mjs ${STANDALONE_APP_DIR}/migrations\n`;

/**
 * Rewrite a cloned node-template overlay so its migrate initContainers target the node-at-root
 * image layout (`/app/app`). The Doltgres command lives in the overlay and is rewritten in place;
 * the Postgres migrate command lives in the shared base, so the override is injected as a patch
 * after the migrate initContainer's secret ref. Idempotent.
 */
function applyNodeAtRootMigratePaths(overlay: string): string {
  const doltFixed = overlay.replace(MONOREPO_APP_DIR_RE, STANDALONE_APP_DIR);
  if (doltFixed.includes("/spec/template/spec/initContainers/0/command/2")) {
    return doltFixed;
  }
  return doltFixed.replace(
    MIGRATE_SECRET_ANCHOR_RE,
    (match) => `${match}${POSTGRES_MIGRATE_OVERRIDE}`
  );
}

/**
 * Clone the node-template overlay for one env into the new node's overlay. `templateOverlay` is the
 * source `infra/k8s/overlays/<env>/node-template/kustomization.yaml`; the env identity is carried by
 * that content (no substitution needed). Rewrites slug + the two well-known port literals, then
 * normalizes the migrate runner paths to the node-at-root image layout.
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
  const secreted = options.secretTargetName
    ? ported.split(`${slug}-node-app-secrets`).join(options.secretTargetName)
    : ported;
  return applyNodeAtRootMigratePaths(secreted);
}
