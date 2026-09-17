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
 *   `parseCatalogPlacementMap`/`setCatalogPlacementCell` do the same block-level edit for the per-env
 *   placement maps — `deployment_provider`, `compute_api`, `lease_generation` (story.5039) — each a
 *   `<key>:\n  <env>: <value>` block whose cells are upserted/dropped per env. `setCatalogPlacement`
 *   stays as the placement-verb wrapper (story.5016 T5): k3s is the schema default there, so it
 *   deletes the env's entry and drops an emptied block.
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
 * The per-env placement map keys the catalog carries, in the ORDER a row emits them — the shape
 * PR #2301 hand-wrote for poly: `deployment_provider`, then `compute_api`, then `lease_generation`.
 * A new block is inserted after the nearest preceding key's block (else after the `envs:` line), so
 * generated rows keep that ordering.
 */
export const CATALOG_PLACEMENT_KEYS = [
  "deployment_provider",
  "compute_api",
  "lease_generation",
] as const;
export type CatalogPlacementKey = (typeof CATALOG_PLACEMENT_KEYS)[number];

/** Per-key value vocabulary, mirroring `infra/catalog/_schema.json`. */
const PLACEMENT_VALUE_RES: Readonly<Record<CatalogPlacementKey, RegExp>> = {
  deployment_provider: /^(?:k3s|akash)$/,
  compute_api: /^(?:legacy|crossplane)$/,
  lease_generation: /^(?:0|[1-9][0-9]*)$/,
};

/**
 * Matches one placement map's block — the `<key>:` header line plus every following indented entry
 * line. Entry lines are `  <env>: <value>` (two-space indent by convention, any horizontal indent
 * accepted on read). The capture ends at the first non-indented line, so sibling top-level keys and
 * their comments are untouched.
 */
const placementBlockRe = (key: CatalogPlacementKey): RegExp =>
  new RegExp(`^${key}:[^\\S\\r\\n]*\\n((?:[ \\t]+[^\\n]*(?:\\n|$))*)`, "m");
const PLACEMENT_ENTRY_RE =
  /^[ \t]+([a-z-]+):[^\S\r\n]*([a-z0-9]+)[^\S\r\n]*(?:#.*)?$/;
const SOURCE_REPO_LINE_RE = /^source_repo:[^\S\r\n]*(\S+)[^\S\r\n]*$/m;

/** True when the catalog row declares a `source_repo:` (an external build plane exists). */
export function hasCatalogSourceRepo(catalogYaml: string): boolean {
  return SOURCE_REPO_LINE_RE.test(catalogYaml);
}

/** Read the catalog row's `source_repo:` URL. Throws if absent — check {@link hasCatalogSourceRepo} first. */
export function parseCatalogSourceRepo(catalogYaml: string): string {
  const match = SOURCE_REPO_LINE_RE.exec(catalogYaml);
  if (!match || match[1] === undefined) {
    throw new Error(
      "catalog row has no `source_repo:` line; it has no external build plane."
    );
  }
  return match[1];
}

const NODE_ID_LINE_RE = /^node_id:[^\S\r\n]*(\S+)[^\S\r\n]*$/m;

/**
 * Read the catalog row's `node_id:` (REPO_SPEC_IS_IDENTITY_SSOT projection) — the UUID alias the
 * scheduler-worker routing CSV keys on (bug.5094). Every `source_repo:`-bearing row carries one;
 * throws if absent so a caller cannot silently render a routing update under no identity.
 */
export function parseCatalogNodeId(catalogYaml: string): string {
  const match = NODE_ID_LINE_RE.exec(catalogYaml);
  if (!match || match[1] === undefined) {
    throw new Error(
      "catalog row is missing a `node_id: <uuid>` line; cannot resolve its scheduler routing identity."
    );
  }
  return match[1];
}

/**
 * Read one placement map's per-env cells (`deployment_provider`, `compute_api`, `lease_generation`).
 * An absent block (or an env absent from it) means that key's schema default — callers resolve
 * `map[env] ?? <default>`. Throws on unknown env keys or out-of-vocabulary values so a hand-mangled
 * catalog fails loudly, not silently-as-default.
 */
export function parseCatalogPlacementMap(
  catalogYaml: string,
  key: CatalogPlacementKey
): Partial<Record<NodeFormationEnv, string>> {
  const match = placementBlockRe(key).exec(catalogYaml);
  if (!match || match[1] === undefined) return {};
  const map: Partial<Record<NodeFormationEnv, string>> = {};
  for (const line of match[1].split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const entry = PLACEMENT_ENTRY_RE.exec(line);
    if (!entry || entry[1] === undefined || entry[2] === undefined) {
      throw new Error(
        `catalog \`${key}:\` has an unparseable entry line: '${line.trim()}'.`
      );
    }
    const [, env, value] = entry;
    if (!isNodeFormationEnv(env)) {
      throw new Error(`catalog \`${key}:\` names an unknown env '${env}'.`);
    }
    if (!PLACEMENT_VALUE_RES[key].test(value)) {
      throw new Error(
        `catalog \`${key}:\` has an unknown value '${value}' for '${env}'.`
      );
    }
    map[env] = value;
  }
  return map;
}

/**
 * Re-emit one placement map's block with `env`'s cell set to `value` (or the entry REMOVED when
 * `value` is undefined — the whole block drops once it empties, because the schema's
 * `minProperties: 1` makes an entry-less map invalid). Entries are emitted in the canonical env
 * order; other envs' parsed values are carried through verbatim.
 *
 * A block created from scratch is inserted after the nearest PRECEDING key's block per
 * {@link CATALOG_PLACEMENT_KEYS} order (deployment_provider → compute_api → lease_generation, the
 * shape #2301 hand-wrote), else immediately after the `envs:` line (the one line every catalog row
 * is guaranteed to carry). Like `setCatalogEnvs`, this is a line-level edit, NOT a YAML round-trip —
 * every other byte of the file (comments included) is preserved.
 */
export function setCatalogPlacementCell(
  catalogYaml: string,
  key: CatalogPlacementKey,
  env: NodeFormationEnv,
  value: string | undefined
): string {
  if (value !== undefined && !PLACEMENT_VALUE_RES[key].test(value)) {
    throw new Error(
      `catalog \`${key}:\` cannot be set to unknown value '${value}' for '${env}'.`
    );
  }
  const map = parseCatalogPlacementMap(catalogYaml, key);
  if (value === undefined) {
    delete map[env];
  } else {
    map[env] = value;
  }

  const entries = ENV_ORDER.filter((e) => map[e] !== undefined).map(
    (e) => `  ${e}: ${map[e]}`
  );
  const block = entries.length > 0 ? `${key}:\n${entries.join("\n")}\n` : "";

  const existing = placementBlockRe(key).exec(catalogYaml);
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
    return catalogYaml; // deleting a cell of a block-less row: already the default form.
  }

  // NEW block: anchor after the last existing predecessor key's block, else after the envs: line.
  for (const prior of CATALOG_PLACEMENT_KEYS.slice(
    0,
    CATALOG_PLACEMENT_KEYS.indexOf(key)
  ).reverse()) {
    const priorBlock = placementBlockRe(prior).exec(catalogYaml);
    if (priorBlock) {
      return insertAfter(
        catalogYaml,
        priorBlock.index + priorBlock[0].length,
        block,
        priorBlock[0].endsWith("\n")
      );
    }
  }
  const envsLine = ENVS_LINE_RE.exec(catalogYaml);
  if (!envsLine) {
    throw new Error(
      `catalog row is missing a flow-sequence \`envs: [...]\` line; cannot place the \`${key}:\` block.`
    );
  }
  const afterEnvsLine = envsLine.index + envsLine[0].length;
  return insertAfter(
    catalogYaml,
    afterEnvsLine,
    block,
    catalogYaml[afterEnvsLine] === "\n",
    /* skipAnchorNewline */ true
  );
}

/**
 * Insert a newline-terminated `block` after the anchor ending at `at`. When the anchor ends the
 * file WITHOUT a newline, one is prepended and the block's own terminator dropped so the file's
 * missing-final-newline property is preserved (mirrors the bug.5073-shaped envs-line handling).
 * `skipAnchorNewline` steps past the anchor's own `\n` when the anchor match excluded it.
 */
function insertAfter(
  catalogYaml: string,
  at: number,
  block: string,
  anchorHasNewline: boolean,
  skipAnchorNewline = false
): string {
  if (!anchorHasNewline) {
    return `${catalogYaml.slice(0, at)}\n${block.slice(0, -1)}${catalogYaml.slice(at)}`;
  }
  const insertAt = skipAnchorNewline ? at + 1 : at;
  return catalogYaml.slice(0, insertAt) + block + catalogYaml.slice(insertAt);
}

/**
 * Read the catalog row's `deployment_provider:` per-env placement map. An absent block (or an env
 * absent from it) means the k3s default — callers resolve `map[env] ?? "k3s"`. Thin wrapper over
 * {@link parseCatalogPlacementMap} narrowing values to {@link PlacementProvider}.
 */
export function parseCatalogPlacement(
  catalogYaml: string
): Partial<Record<NodeFormationEnv, PlacementProvider>> {
  return parseCatalogPlacementMap(
    catalogYaml,
    "deployment_provider"
  ) as Partial<Record<NodeFormationEnv, PlacementProvider>>;
}

/**
 * Re-emit the catalog row's `deployment_provider:` block with `env` placed on `provider` — the
 * PLACEMENT verb's editor (story.5016 T5). Canonical form THERE: k3s is the schema DEFAULT (an
 * omitted env means k3s), so setting k3s REMOVES the env's entry rather than writing `<env>: k3s`.
 * The ADD path (story.5039) writes akash cells explicitly via {@link setCatalogPlacementCell} —
 * activation states its placement in git, it does not elide defaults.
 */
export function setCatalogPlacement(
  catalogYaml: string,
  env: NodeFormationEnv,
  provider: PlacementProvider
): string {
  return setCatalogPlacementCell(
    catalogYaml,
    "deployment_provider",
    env,
    provider === "k3s" ? undefined : provider
  );
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
