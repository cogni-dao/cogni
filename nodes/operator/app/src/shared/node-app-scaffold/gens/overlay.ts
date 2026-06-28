// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/overlay`
 * Purpose: Pure port of `scaffold-node.sh` step 5 — clone the `node-template` per-env
 *   `kustomization.yaml` into a new node's overlay, so the operator can author a node-formation PR
 *   without `cp -R` + sed on a checkout.
 * Scope: Given the CURRENT committed `infra/k8s/overlays/<env>/node-template/kustomization.yaml`
 *   and the new node's `slug` + `nodePort` + container `port`, return the overlay byte-identical to
 *   what `render-node-overlays.sh <env> <slug>` emits. Env-specific content (namespace, externalName,
 *   NEXTAUTH host) rides along from the source overlay unchanged.
 * Invariants:
 *   - SCAFFOLD_OUTPUT_PARITY — the ONLY transforms are `s/node-template/<slug>/g` then the
 *     word-bounded port literals (`s/\b30200\b/<nodePort>/g; s/\b3200\b/<port>/g`; 30200 before 3200
 *     so the `\b30200\b` match is not shadowed). The node-template template overlay already carries
 *     the node-at-root image layout (/app/app) and the ESO `<slug>-env-secrets` target directly.
 *     Nodes may opt out of the template Doltgres initContainer with catalog
 *     `doltgres_migrator: false`; otherwise there is no path or secret rewrite. Byte-exact twin of
 *     `render-node-overlays.sh`.
 *   - NODE_AT_ROOT_MIGRATE_PATH — wizard-born nodes ship node-at-root images whose app tree is at
 *     `/app/app`. The template overlay carries `/app/app` migrate commands directly; this fails
 *     closed if the node-at-root Postgres migrate command is absent (a wrong path silently
 *     crash-loops the migrate initContainer).
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: scripts/ci/render-node-overlays.sh, scripts/setup/scaffold-node.sh, docs/spec/node-baas-architecture.md
 * @public
 */

const TEMPLATE_SLUG = "node-template";

/** Node-at-root standalone image app root. See NODE_AT_ROOT_MIGRATE_PATH. */
const STANDALONE_APP_DIR = "/app/app";

/** The Postgres migrate command the template must carry for a node-at-root image. */
const NODE_AT_ROOT_MIGRATE_CMD = `exec node ${STANDALONE_APP_DIR}/migrate.mjs ${STANDALONE_APP_DIR}/migrations`;

const NODE_AT_ROOT_DOLTGRES_MIGRATE_CMD = `exec node ${STANDALONE_APP_DIR}/migrate-doltgres.mjs ${STANDALONE_APP_DIR}/doltgres-migrations`;

const DOLTGRES_MIGRATOR_PATCH_RE =
  /\n {2}# task\.5077:[^\n]*\n(?: {2}# [^\n]*\n)* {2}- target:\n {6}kind: Deployment\n {6}name: node-app\n {4}patch: \|\n[\s\S]*?(?=\n {2}(?:#|- target:))/;

export type RenderOverlayOptions = {
  readonly includeDoltgresMigrator?: boolean;
};

/**
 * Clone the node-template overlay for one env into the new node's overlay. `templateOverlay` is the
 * source `infra/k8s/overlays/<env>/node-template/kustomization.yaml`; the env identity is carried by
 * that content (no substitution needed). The only transforms are the slug rename and the two
 * well-known port literals — the template already carries the node-at-root migrate paths and the ESO
 * `<slug>-env-secrets` target. `options.includeDoltgresMigrator` mirrors catalog
 * `doltgres_migrator` and defaults to true. Throws if the node-at-root Postgres migrate command is
 * absent (NODE_AT_ROOT_MIGRATE_PATH).
 */
export function renderOverlay(
  templateOverlay: string,
  slug: string,
  nodePort: number,
  port: number,
  options: RenderOverlayOptions = {}
): string {
  const includeDoltgresMigrator = options.includeDoltgresMigrator ?? true;
  // Rename slug first, then the word-bounded port literals (30200 must be rewritten before 3200 so
  // the `\b30200\b` match is not shadowed by a naive `3200` substring).
  let rendered = templateOverlay
    .split(TEMPLATE_SLUG)
    .join(slug)
    .replace(/\b30200\b/g, String(nodePort))
    .replace(/\b3200\b/g, String(port));
  if (!includeDoltgresMigrator) {
    rendered = rendered.replace(DOLTGRES_MIGRATOR_PATCH_RE, "");
  }
  if (!rendered.includes(NODE_AT_ROOT_MIGRATE_CMD)) {
    throw new Error(
      "renderOverlay: node-template template overlay is missing the node-at-root Postgres " +
        "migrate command (NODE_AT_ROOT_MIGRATE_PATH)."
    );
  }
  if (
    includeDoltgresMigrator &&
    !rendered.includes(NODE_AT_ROOT_DOLTGRES_MIGRATE_CMD)
  ) {
    throw new Error(
      "renderOverlay: node-template template overlay is missing the node-at-root Doltgres " +
        "migrate command (DOLTGRES_MIGRATOR)."
    );
  }
  if (!includeDoltgresMigrator && rendered.includes("migrate-doltgres")) {
    throw new Error(
      "renderOverlay: catalog disables doltgres_migrator but the rendered overlay still " +
        "contains migrate-doltgres."
    );
  }
  return rendered;
}
