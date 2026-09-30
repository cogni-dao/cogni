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
 *   - SCAFFOLD_OUTPUT_PARITY — the structural transforms are `s/node-template/<slug>/g` then the
 *     word-bounded port literals (`s/\b30200\b/<nodePort>/g; s/\b3200\b/<port>/g`; 30200 before 3200
 *     so the `\b30200\b` match is not shadowed). The node-template template overlay already carries
 *     the node-at-root image layout (/app/app) and the ESO `<slug>-env-secrets` target directly —
 *     there is no path or secret rewrite. A supplied fleet domain rewrites only NEXTAUTH_URL's
 *     public host; VM service-discovery domains remain unchanged. Byte-exact twin otherwise.
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

/**
 * Clone the node-template overlay for one env into the new node's overlay. `templateOverlay` is the
 * source `infra/k8s/overlays/<env>/node-template/kustomization.yaml`; the env identity is carried by
 * that content. The transforms are the slug rename, the two well-known port literals, and an optional
 * public NEXTAUTH_URL domain rewrite for an isolated fleet. Throws if the node-at-root Postgres
 * migrate command is absent (NODE_AT_ROOT_MIGRATE_PATH).
 */
export function renderOverlay(
  templateOverlay: string,
  slug: string,
  nodePort: number,
  port: number,
  publicDomainRoot?: string
): string {
  const rendered = rewriteNextAuthDomain(
    applyOverlayTransforms(templateOverlay, slug, nodePort, port),
    publicDomainRoot
  );
  if (!rendered.includes(NODE_AT_ROOT_MIGRATE_CMD)) {
    throw new Error(
      "renderOverlay: node-template template overlay is missing the node-at-root Postgres " +
        "migrate command (NODE_AT_ROOT_MIGRATE_PATH)."
    );
  }
  return rendered;
}

/** Rewrite only the browser-facing node origin; VM service discovery remains on its own zone. */
function rewriteNextAuthDomain(
  content: string,
  publicDomainRoot?: string
): string {
  const domainRoot = publicDomainRoot?.trim();
  if (!domainRoot || domainRoot === "cognidao.org") return content;
  return content.replace(
    /(path:\s*\/data\/NEXTAUTH_URL\s*\n\s*value:\s*"https:\/\/)([^"\n]+)(")/,
    (_match, prefix: string, host: string, suffix: string) => {
      const canonicalSuffix = ".cognidao.org";
      if (!host.endsWith(canonicalSuffix)) return `${prefix}${host}${suffix}`;
      return `${prefix}${host.slice(0, -canonicalSuffix.length)}.${domainRoot}${suffix}`;
    }
  );
}

/**
 * Render a SIBLING file the node-template overlay dir carries besides the kustomization — today the
 * ESO producer `external-secret.yaml` (creates `<slug>-env-secrets`; without it the pod's
 * `envFrom: <slug>-env-secrets` names a Secret nothing creates → CreateContainerConfigError). Same
 * byte-exact transform as {@link renderOverlay} MINUS the node-at-root migrate guard (only the
 * kustomization.yaml carries a migrate command). Byte-exact twin of `render-node-overlays.sh`'s
 * `render_file` for a non-kustomization overlay file.
 */
export function renderOverlayFile(
  templateFile: string,
  slug: string,
  nodePort: number,
  port: number
): string {
  return applyOverlayTransforms(templateFile, slug, nodePort, port);
}

/**
 * The one byte-exact overlay transform both {@link renderOverlay} and {@link renderOverlayFile} share:
 * rename the slug first, then the word-bounded port literals (30200 must be rewritten before 3200 so
 * the `\b30200\b` match is not shadowed by a naive `3200` substring). Mirrors the perl in
 * `render-node-overlays.sh render_file`.
 */
function applyOverlayTransforms(
  content: string,
  slug: string,
  nodePort: number,
  port: number
): string {
  return content
    .split(TEMPLATE_SLUG)
    .join(slug)
    .replace(/\b30200\b/g, String(nodePort))
    .replace(/\b3200\b/g, String(port));
}
