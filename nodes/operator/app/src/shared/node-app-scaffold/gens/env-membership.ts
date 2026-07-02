// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/env-membership`
 * Purpose: Pure editor for ONE catalog row's `envs:` line — the per-env node-set the operator adds or
 *   drops an env from when managing a node's deploy reach (story.5020 W4). The inverse-twin of the
 *   birth-time `envs` array baked by `renderCatalog`: this edits an EXISTING catalog file in place,
 *   touching ONLY the `envs:` line so every other byte (comments, node_port, branches, path_prefix)
 *   is preserved verbatim.
 * Scope: `parseCatalogEnvs` reads the flow-sequence `envs: [a, b, c]` line; `setCatalogEnvs` re-emits
 *   that single line with a new, canonically-ordered env-set, leaving the rest of the file untouched.
 * Invariants:
 *   - ATOMIC_PER_ENV — the env-set is an independent per-env set; ANY subset is valid, including the
 *     empty set (`envs: []`, the node deployed nowhere). This module is a mechanical line-editor and
 *     does NOT police the env-set — no mandatory env, no candidate-a special-casing.
 *   - ENV_ORDER_CANONICAL — emitted in the fixed `candidate-a < preview < production` order so the
 *     catalog row stays byte-stable against `render-node-appset.sh` / the catalog goldens regardless
 *     of the order the caller supplies.
 *   - SINGLE_LINE_EDIT — only the `envs:` flow line changes; throws if the row has no such line.
 * Side-effects: none — pure string transforms, no IO, no env.
 * Links: infra/catalog/_schema.json (`envs`), src/shared/node-app-scaffold/gens/catalog, story.5020
 * @public
 */

import { NODE_FORMATION_ENVS, type NodeFormationEnv } from "./envs";

/** Canonical env order (candidate-a < preview < production) — the order the catalog row is emitted in. */
const ENV_ORDER = NODE_FORMATION_ENVS;

/** Matches the catalog row's flow-sequence `envs:` line, e.g. `envs: [candidate-a, preview, production]`. */
const ENVS_LINE_RE = /^envs:\s*\[([^\]]*)\]\s*$/m;

/** Read the catalog row's `envs:` flow-sequence into its env-set, in file order. Throws if absent. */
export function parseCatalogEnvs(catalogYaml: string): NodeFormationEnv[] {
  const match = ENVS_LINE_RE.exec(catalogYaml);
  if (!match || match[1] === undefined) {
    throw new Error(
      "catalog row is missing a flow-sequence `envs: [...]` line; cannot read its env-set."
    );
  }
  const inner = match[1].trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((cell) => {
    const env = cell.trim();
    if (!isNodeFormationEnv(env)) {
      throw new Error(`catalog \`envs:\` contains an unknown env '${env}'.`);
    }
    return env;
  });
}

function isNodeFormationEnv(value: string): value is NodeFormationEnv {
  return (ENV_ORDER as readonly string[]).includes(value);
}

/** Re-emit the catalog row's `envs:` flow-sequence line with `envs`, canonically ordered + de-duped. */
export function setCatalogEnvs(
  catalogYaml: string,
  envs: readonly NodeFormationEnv[]
): string {
  if (!ENVS_LINE_RE.test(catalogYaml)) {
    throw new Error(
      "catalog row is missing a flow-sequence `envs: [...]` line; cannot edit its env-set."
    );
  }
  const ordered = ENV_ORDER.filter((env) => envs.includes(env));
  return catalogYaml.replace(ENVS_LINE_RE, `envs: [${ordered.join(", ")}]`);
}

/** Convenience: the env-set with `env` folded in (canonically ordered). Idempotent. */
export function addCatalogEnv(
  current: readonly NodeFormationEnv[],
  env: NodeFormationEnv
): NodeFormationEnv[] {
  return ENV_ORDER.filter((e) => current.includes(e) || e === env);
}

/** Convenience: the env-set with `env` dropped. Idempotent. */
export function dropCatalogEnv(
  current: readonly NodeFormationEnv[],
  env: NodeFormationEnv
): NodeFormationEnv[] {
  return current.filter((e) => e !== env);
}
