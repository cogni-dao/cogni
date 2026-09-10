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
 *   `parseCatalogPlacement`/`setCatalogPlacement` do the same block-level edit for the per-env
 *   `deployment_provider:` map (story.5016 T5) — k3s is the schema default, so the canonical form
 *   omits k3s entries and drops an emptied block.
 * Invariants:
 *   - NONEMPTY_DEPLOY_SET — individual membership is independently editable, but at least one
 *     environment must remain. Full decommission is a separate lifecycle operation.
 *   - ACTIVITY_AUTHORITY_STAYS_DEPLOYED — the env-membership verb cannot remove the current
 *     `activity_env`; authority transfer needs a future fenced quiesce/activate protocol.
 *   - ENV_ORDER_CANONICAL — emitted in the fixed `candidate-a < preview < production` order so the
 *     catalog row stays byte-stable against `render-node-appset.sh` / the catalog goldens regardless
 *     of the order the caller supplies.
 *   - SINGLE_LINE_EDIT — only the `envs:` flow line changes; throws if the row has no such line.
 * Side-effects: none — pure string transforms, no IO, no env.
 * Links: infra/catalog/_schema.json (`envs`), src/shared/node-app-scaffold/gens/catalog, story.5020
 * @public
 */

import { NODE_DEPLOY_ENVS, type NodeFormationEnv } from "./envs";

/** Canonical env order (candidate-a < preview < production) — the order the catalog row is emitted in. */
const ENV_ORDER = NODE_DEPLOY_ENVS;

/**
 * Matches the catalog row's flow-sequence `envs:` line, e.g. `envs: [candidate-a, preview, production]`.
 * The trailing class is `[^\S\r\n]*` (horizontal whitespace only), NOT `\s*` — `\s` includes `\n`, so a
 * greedy `\s*$` on a file whose LAST line is the `envs:` row consumes the file's final newline, and
 * `setCatalogEnvs`'s replacement (which has no newline) then strips it → the verb's catalog PR fails
 * prettier's require-final-newline (bug.5073). Matching only horizontal whitespace leaves `\n` intact.
 */
const ENVS_LINE_RE = /^envs:\s*\[([^\]]*)\][^\S\r\n]*$/m;
const ACTIVITY_ENV_LINE_RE = /^activity_env:\s*([^\s#]+)[^\S\r\n]*(?:#.*)?$/m;

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

/** Read the singleton `activity_env` from one catalog row. Throws if absent/unknown. */
export function parseCatalogActivityEnv(catalogYaml: string): NodeFormationEnv {
  const value = ACTIVITY_ENV_LINE_RE.exec(catalogYaml)?.[1];
  if (!value || !isNodeFormationEnv(value)) {
    throw new Error(
      "catalog row is missing a valid `activity_env: <env>` line."
    );
  }
  return value;
}

export type EnvRemovalViolation =
  | "final_environment_required"
  | "activity_authority_cutover_required";

/** Shared route/planner guard for the two removals the v1 contract cannot safely express. */
export function envRemovalViolation(input: {
  readonly currentEnvs: readonly NodeFormationEnv[];
  readonly activityEnv: NodeFormationEnv;
  readonly removeEnv: NodeFormationEnv;
}): EnvRemovalViolation | null {
  if (!input.currentEnvs.includes(input.removeEnv)) return null;
  if (input.currentEnvs.length === 1) return "final_environment_required";
  if (input.activityEnv === input.removeEnv) {
    return "activity_authority_cutover_required";
  }
  return null;
}

function isNodeFormationEnv(value: string): value is NodeFormationEnv {
  return (ENV_ORDER as readonly string[]).includes(value);
}

/**
 * Rank an env by ingest proximity: how close it sits to the one environment that can
 * actually receive a Git receipt. GitHub App webhooks are delivered to PRODUCTION only
 * (one App, one webhook URL), so `production` is the maximum by definition.
 *
 * Declared explicitly rather than read off `NODE_DEPLOY_ENVS`'s array order. That constant
 * documents only "every environment that can be managed after birth" — it carries no
 * ordering contract, so `indexOf` would make its literal order silently load-bearing for a
 * semantic rule. Re-sorting it (say, alphabetically) would invert the ranking and every
 * test would still pass, for the wrong reason.
 */
const ENV_INGEST_RANK: Readonly<Record<NodeFormationEnv, number>> = {
  "candidate-a": 0,
  preview: 1,
  production: 2,
};

export function envRank(env: NodeFormationEnv): number {
  return ENV_INGEST_RANK[env];
}

/**
 * Re-emit the catalog row's `activity_env:` line, carrying any trailing comment across.
 *
 * The trailing comment is preserved on purpose: `ACTIVITY_ENV_LINE_RE` matches it, so a
 * naive whole-line replacement DELETES it. These rows carry load-bearing comments and a
 * silent drop is exactly the kind of edit nobody notices in a generated PR.
 *
 * Deliberately a line rewrite rather than a YAML round-trip, because a serializer would
 * drop every comment in the file. Mirrors `setCatalogEnvs`, including its
 * horizontal-whitespace-only trailing class that keeps the file's final newline (bug.5073).
 */
export function setCatalogActivityEnv(
  catalogYaml: string,
  env: NodeFormationEnv
): string {
  const match = ACTIVITY_ENV_LINE_RE.exec(catalogYaml);
  if (!match) {
    throw new Error(
      "catalog row is missing a valid `activity_env: <env>` line; cannot set it."
    );
  }
  const trailingComment = /#.*$/.exec(match[0])?.[0];
  const line = trailingComment
    ? `activity_env: ${env} ${trailingComment}`
    : `activity_env: ${env}`;
  return catalogYaml.replace(ACTIVITY_ENV_LINE_RE, line);
}

/** Re-emit the catalog row's `envs:` flow-sequence line with `envs`, canonically ordered + de-duped. */
export function setCatalogEnvs(
  catalogYaml: string,
  envs: readonly NodeFormationEnv[]
): string {
  if (envs.length === 0) {
    throw new Error(
      "catalog `envs` must retain at least one environment; use the decommission lifecycle to remove a node entirely."
    );
  }
  if (!ENVS_LINE_RE.test(catalogYaml)) {
    throw new Error(
      "catalog row is missing a flow-sequence `envs: [...]` line; cannot edit its env-set."
    );
  }
  const ordered = ENV_ORDER.filter((env) => envs.includes(env));
  return catalogYaml.replace(ENVS_LINE_RE, `envs: [${ordered.join(", ")}]`);
}

/** The two app-placement providers the catalog's `deployment_provider` map admits. */
export const PLACEMENT_PROVIDERS = ["k3s", "akash"] as const;
export type PlacementProvider = (typeof PLACEMENT_PROVIDERS)[number];

/**
 * Matches the catalog row's `deployment_provider:` block — the header line plus every following
 * indented entry line. Entry lines are `  <env>: <provider>` (two-space indent by convention, any
 * horizontal indent accepted on read). The capture ends at the first non-indented line, so sibling
 * top-level keys and their comments are untouched.
 */
const PLACEMENT_BLOCK_RE =
  /^deployment_provider:[^\S\r\n]*\n((?:[ \t]+[^\n]*(?:\n|$))*)/m;
const PLACEMENT_ENTRY_RE =
  /^[ \t]+([a-z-]+):[^\S\r\n]*([a-z0-9]+)[^\S\r\n]*(?:#.*)?$/;
const SOURCE_REPO_LINE_RE = /^source_repo:[^\S\r\n]*\S/m;

/** True when the catalog row declares a `source_repo:` (an external build plane exists). */
export function hasCatalogSourceRepo(catalogYaml: string): boolean {
  return SOURCE_REPO_LINE_RE.test(catalogYaml);
}

/**
 * Read the catalog row's `deployment_provider:` per-env placement map. An absent block (or an env
 * absent from it) means the k3s default — callers resolve `map[env] ?? "k3s"`. Throws on unknown
 * env keys or provider values so a hand-mangled catalog fails loudly, not silently-as-k3s.
 */
export function parseCatalogPlacement(
  catalogYaml: string
): Partial<Record<NodeFormationEnv, PlacementProvider>> {
  const match = PLACEMENT_BLOCK_RE.exec(catalogYaml);
  if (!match || match[1] === undefined) return {};
  const map: Partial<Record<NodeFormationEnv, PlacementProvider>> = {};
  for (const line of match[1].split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const entry = PLACEMENT_ENTRY_RE.exec(line);
    if (!entry || entry[1] === undefined || entry[2] === undefined) {
      throw new Error(
        `catalog \`deployment_provider:\` has an unparseable entry line: '${line.trim()}'.`
      );
    }
    const [, env, provider] = entry;
    if (!isNodeFormationEnv(env)) {
      throw new Error(
        `catalog \`deployment_provider:\` names an unknown env '${env}'.`
      );
    }
    if (!(PLACEMENT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(
        `catalog \`deployment_provider:\` has an unknown provider '${provider}' for '${env}'.`
      );
    }
    map[env] = provider as PlacementProvider;
  }
  return map;
}

/**
 * Re-emit the catalog row's `deployment_provider:` block with `env` placed on `provider`.
 *
 * Canonical form: k3s is the schema DEFAULT (an omitted env means k3s), so setting k3s REMOVES the
 * env's entry rather than writing `<env>: k3s` — and drops the whole block once it empties, because
 * the schema's `minProperties: 1` makes an entry-less map invalid. Setting akash upserts the entry.
 * Entries are emitted in the canonical env order; other envs' parsed values are carried through
 * verbatim. A block created from scratch is inserted immediately after the `envs:` line (the one
 * line every catalog row is guaranteed to carry). Like `setCatalogEnvs`, this is a line-level edit,
 * NOT a YAML round-trip — every other byte of the file (comments included) is preserved.
 */
export function setCatalogPlacement(
  catalogYaml: string,
  env: NodeFormationEnv,
  provider: PlacementProvider
): string {
  const map = parseCatalogPlacement(catalogYaml);
  if (provider === "k3s") {
    delete map[env];
  } else {
    map[env] = provider;
  }

  const entries = ENV_ORDER.filter((e) => map[e] !== undefined).map(
    (e) => `  ${e}: ${map[e]}`
  );
  const block =
    entries.length > 0 ? `deployment_provider:\n${entries.join("\n")}\n` : "";

  const existing = PLACEMENT_BLOCK_RE.exec(catalogYaml);
  if (existing) {
    // Preserve an EOF-without-newline block verbatim minus its missing terminator.
    const matched = existing[0];
    const replacement =
      block !== "" && !matched.endsWith("\n") ? block.slice(0, -1) : block;
    return (
      catalogYaml.slice(0, existing.index) +
      replacement +
      catalogYaml.slice(existing.index + matched.length)
    );
  }
  if (block === "") {
    return catalogYaml; // k3s onto a block-less row: already the default form.
  }
  const envsLine = ENVS_LINE_RE.exec(catalogYaml);
  if (!envsLine) {
    throw new Error(
      "catalog row is missing a flow-sequence `envs: [...]` line; cannot place the `deployment_provider:` block."
    );
  }
  const afterEnvsLine = envsLine.index + envsLine[0].length;
  if (catalogYaml[afterEnvsLine] !== "\n") {
    // envs line ends the file without a newline — append, keeping the block newline-terminated.
    return `${catalogYaml.slice(0, afterEnvsLine)}\n${block.slice(0, -1)}${catalogYaml.slice(afterEnvsLine)}`;
  }
  const insertAt = afterEnvsLine + 1; // past the envs line's newline
  return catalogYaml.slice(0, insertAt) + block + catalogYaml.slice(insertAt);
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
