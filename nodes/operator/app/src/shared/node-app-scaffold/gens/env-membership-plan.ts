// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/env-membership-plan`
 * Purpose: Pure delta-planner for the node env-membership verb (story.5020 W4). Given a node's CURRENT
 *   committed control-plane files + a requested `{env, present}` mutation, return the exact set of file
 *   upserts/deletes the operator must commit — WITHOUT touching GitHub. The adapter
 *   ({@link GitHubRepoWriter.openNodeEnvPr}) turns each `upsert` into a blob + each `delete` into a
 *   `sha:null` tree entry; this module owns ALL the add/remove/full-decommission branching so it is
 *   unit-testable without Octokit.
 * Scope: Composes the byte-exact single-file gens (`setCatalogEnvs`, `renderOverlay`, `renderNodeAppset`,
 *   `insert/removeFromAppsetsKustomization`, `removeCaddyBlock`, `removeSchedulerEndpoint`) over the
 *   current contents the adapter fetches on main. NO IO, NO env, NO blob SHAs — the adapter resolves
 *   those.
 * Invariants:
 *   - CANDIDATE_A_ALWAYS — a node can never hold envs without candidate-a (schema `contains: candidate-a`).
 *     So removing `candidate-a` is NOT a partial trim: it is the FULL DECOMMISSION path (the node leaves the
 *     catalog entirely, taking preview/production with it). Removing the last remaining env is likewise a
 *     full decommission, never an empty `envs: []` row. A partial remove that would strip candidate-a from a
 *     corrupt (already candidate-a-less) row is refused (422).
 *   - IDEMPOTENT — requesting the state that already holds (env already present on add / already absent on
 *     remove) yields an EMPTY op list (`{ kind: "no_changes" }`), so the adapter opens no PR.
 *   - DELETE_VIA_SHA_NULL — file removals are emitted as `{ op: "delete", path }`; the adapter maps these
 *     to `{ sha: null }` tree entries (delete-from-base_tree).
 * Side-effects: none — pure string transforms.
 * Links: src/adapters/server/vcs/github-repo-write.ts (openNodeEnvPr), docs/design/operator-fleet-safety.md, story.5020
 * @public
 */

import {
  insertAppsetKustomization,
  removeFromAppsetsKustomization,
  renderNodeAppset,
} from "./appset";
import { removeCaddyBlock } from "./caddyfile";
import {
  addCatalogEnv,
  dropCatalogEnv,
  parseCatalogEnvs,
  setCatalogEnvs,
} from "./env-membership";
import type { NodeFormationEnv } from "./envs";
import { renderOverlay } from "./overlay";
import { removeSchedulerEndpoint } from "./scheduler-endpoints";

/** The candidate-a env can only leave a node's set via a FULL decommission (CANDIDATE_A_ALWAYS). */
const CANDIDATE_A: NodeFormationEnv = "candidate-a";

/** Repo-relative path of a node's per-env overlay kustomization. */
export const overlayPath = (env: string, slug: string): string =>
  `infra/k8s/overlays/${env}/${slug}/kustomization.yaml`;

/** Repo-relative path of a node's per-(env, slug) ApplicationSet object. */
export const appsetPath = (env: string, slug: string): string =>
  `infra/k8s/argocd/appsets/${env}/${env}-${slug}-applicationset.yaml`;

/** Repo-relative path of ONE env's appsets kustomization (the list the slug folds into). */
export const appsetsKustomizationPath = (env: string): string =>
  `infra/k8s/argocd/appsets/${env}/kustomization.yaml`;

export const CATALOG_PATH = (slug: string): string =>
  `infra/catalog/${slug}.yaml`;
export const CADDYFILE_PATH = "infra/compose/edge/configs/Caddyfile.tmpl";
export const SCHEDULER_CONFIGMAP_PATH =
  "infra/k8s/base/scheduler-worker/configmap.yaml";

/** A single file mutation in the plan. `upsert` carries content; `delete` removes the path. */
export type EnvPlanOp =
  | { readonly op: "upsert"; readonly path: string; readonly content: string }
  | { readonly op: "delete"; readonly path: string };

/**
 * The current committed contents the planner reads. The adapter fetches each on main and passes them in;
 * per-env maps are keyed by env. `caddyfile`/`schedulerConfigmap` are only consulted on a full
 * decommission (env-independent edge/routing state); they may be undefined otherwise.
 */
export interface EnvPlanCurrent {
  /** Current `infra/catalog/<slug>.yaml` body on main. */
  readonly catalog: string;
  /** The `node-template` overlay for an env being ADDED (source to clone). Keyed by env. */
  readonly templateOverlayByEnv: Readonly<Record<string, string>>;
  /** The shared `node-applicationset.yaml.tmpl` (only needed on ADD). */
  readonly appsetTemplate?: string | undefined;
  /** Current `appsets/<env>/kustomization.yaml` per env. Keyed by env. */
  readonly appsetsKustomizationByEnv: Readonly<Record<string, string>>;
  /** Container port + node_port for the overlay render (only needed on ADD). */
  readonly port?: number | undefined;
  readonly nodePort?: number | undefined;
  /** Current Caddyfile.tmpl (only consulted on full decommission). */
  readonly caddyfile?: string | undefined;
  /** Current scheduler-worker configmap (only consulted on full decommission). */
  readonly schedulerConfigmap?: string | undefined;
}

export type EnvDeltaResult =
  | { readonly kind: "no_changes" }
  | {
      readonly kind: "add" | "remove" | "decommission";
      readonly ops: readonly EnvPlanOp[];
      /** The node's env-set AFTER the mutation (empty on decommission). */
      readonly nextEnvs: readonly NodeFormationEnv[];
    };

/** Raised when the request violates a catalog invariant (maps to HTTP 422 / 404 in the adapter). */
export class EnvPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "EnvPlanError";
  }
}

/**
 * Pure: compute the file-delta for `{ slug, env, present }` over the node's current control-plane files.
 *
 * - ADD (present, env absent): catalog `envs:` += env, render overlay + appset, fold slug into that env's
 *   appsets kustomization.
 * - REMOVE (¬present, env present, env ≠ candidate-a, others remain): catalog `envs:` −= env, DELETE the
 *   overlay + appset, regenerate that env's appsets kustomization without the slug.
 * - FULL DECOMMISSION (¬present and (env == candidate-a OR removing leaves envs empty)): DELETE the catalog
 *   row, and for EVERY current env DELETE its overlay + appset and regenerate its kustomization without the
 *   slug; regenerate the Caddyfile + scheduler configmap (env-independent, only on full removal).
 * - Idempotent: the already-holding state returns `{ kind: "no_changes" }`.
 *
 * CANDIDATE_A_ALWAYS is enforced here: removing candidate-a always decommissions (never a candidate-a-less
 * node), and a partial remove that would strip candidate-a from a corrupt row throws 422.
 */
export function buildEnvDeltaPlan(input: {
  readonly slug: string;
  readonly env: NodeFormationEnv;
  readonly present: boolean;
  /**
   * Explicit confirmation that the caller intends a FULL node decommission (drop the catalog row, taking
   * preview/production with it). Required whenever a remove resolves to a full decommission — removing
   * candidate-a, or removing the last env. Without it such a remove is REFUSED (422 `decommission_requires_intent`)
   * rather than silently destroying every env. Ignored on add / partial remove.
   */
  readonly decommission?: boolean | undefined;
  readonly current: EnvPlanCurrent;
}): EnvDeltaResult {
  const { slug, env, present, decommission, current } = input;
  const currentEnvs = parseCatalogEnvs(current.catalog);

  if (present) {
    return planAdd({ slug, env, currentEnvs, current });
  }
  return planRemove({
    slug,
    env,
    currentEnvs,
    decommission: decommission === true,
    current,
  });
}

function planAdd(args: {
  slug: string;
  env: NodeFormationEnv;
  currentEnvs: NodeFormationEnv[];
  current: EnvPlanCurrent;
}): EnvDeltaResult {
  const { slug, env, currentEnvs, current } = args;

  // Idempotent: already present → no PR.
  if (currentEnvs.includes(env)) {
    return { kind: "no_changes" };
  }

  const nextEnvs = addCatalogEnv(currentEnvs, env);
  // CANDIDATE_A_ALWAYS: an add must never produce an env-set that excludes candidate-a. (The only way it
  // could is a corrupt current row; refuse loudly rather than emit an invalid catalog.)
  if (!nextEnvs.includes(CANDIDATE_A)) {
    throw new EnvPlanError(
      "candidate_a_always",
      `adding '${env}' to '${slug}' would leave an env-set without candidate-a (CANDIDATE_A_ALWAYS).`,
      422
    );
  }

  const templateOverlay = current.templateOverlayByEnv[env];
  const appsetsKustomization = current.appsetsKustomizationByEnv[env];
  if (
    templateOverlay === undefined ||
    appsetsKustomization === undefined ||
    current.appsetTemplate === undefined ||
    current.port === undefined ||
    current.nodePort === undefined
  ) {
    throw new EnvPlanError(
      "env_render_inputs_missing",
      `cannot render add of '${env}' for '${slug}': missing template overlay, appset template, kustomization, or ports.`,
      422
    );
  }

  const ops: EnvPlanOp[] = [
    {
      op: "upsert",
      path: CATALOG_PATH(slug),
      content: setCatalogEnvs(current.catalog, nextEnvs),
    },
    {
      op: "upsert",
      path: overlayPath(env, slug),
      content: renderOverlay(
        templateOverlay,
        slug,
        current.nodePort,
        current.port
      ),
    },
    {
      op: "upsert",
      path: appsetPath(env, slug),
      content: renderNodeAppset(current.appsetTemplate, slug, env),
    },
    {
      op: "upsert",
      path: appsetsKustomizationPath(env),
      content: insertAppsetKustomization(appsetsKustomization, slug, env),
    },
  ];
  return { kind: "add", ops, nextEnvs };
}

function planRemove(args: {
  slug: string;
  env: NodeFormationEnv;
  currentEnvs: NodeFormationEnv[];
  decommission: boolean;
  current: EnvPlanCurrent;
}): EnvDeltaResult {
  const { slug, env, currentEnvs, decommission, current } = args;

  // Idempotent: already absent → no PR.
  if (!currentEnvs.includes(env)) {
    return { kind: "no_changes" };
  }

  const remaining = dropCatalogEnv(currentEnvs, env);

  // CANDIDATE_A_ALWAYS: a node can never hold envs without candidate-a. So removing candidate-a is NOT a
  // partial trim — it can only mean DROP THE WHOLE NODE (full decommission, removing preview/production
  // too). Likewise, removing the last remaining env is a full decommission rather than an empty `envs: []`
  // row (schema `minItems:1` / `contains: candidate-a`). Both converge on planDecommission below.
  const isFullDecommission = env === CANDIDATE_A || remaining.length === 0;
  if (isFullDecommission) {
    // NOT silent: a full decommission (prod + preview vanish too) must be explicitly confirmed by the
    // caller. A bare `{ env: "candidate-a", present: false }` is refused so a per-env "remove" toggle can
    // never destroy the whole node by accident — the caller must pass `decommission: true` (the UI wires a
    // distinct, confirmed "Decommission" action).
    if (!decommission) {
      throw new EnvPlanError(
        "decommission_requires_intent",
        `removing '${env}' from '${slug}' would decommission the whole node (CANDIDATE_A_ALWAYS takes preview/production too); pass decommission:true to confirm.`,
        422
      );
    }
    return planDecommission({ slug, currentEnvs, current });
  }

  // Partial remove (a non-candidate-a env, others remain): the surviving set MUST still contain
  // candidate-a — refuse otherwise (CANDIDATE_A_ALWAYS). This fires only on a corrupt input row that
  // already lacked candidate-a; a well-formed row always keeps it (candidate-a removal decommissions above).
  if (!remaining.includes(CANDIDATE_A)) {
    throw new EnvPlanError(
      "candidate_a_always",
      `removing '${env}' from '${slug}' would leave an env-set without candidate-a (CANDIDATE_A_ALWAYS).`,
      422
    );
  }

  // Partial remove of a non-candidate-a env, others remain (candidate-a survives).
  const appsetsKustomization = current.appsetsKustomizationByEnv[env];
  if (appsetsKustomization === undefined) {
    throw new EnvPlanError(
      "env_render_inputs_missing",
      `cannot render remove of '${env}' for '${slug}': missing appsets kustomization.`,
      422
    );
  }
  const ops: EnvPlanOp[] = [
    {
      op: "upsert",
      path: CATALOG_PATH(slug),
      content: setCatalogEnvs(current.catalog, remaining),
    },
    { op: "delete", path: overlayPath(env, slug) },
    { op: "delete", path: appsetPath(env, slug) },
    {
      op: "upsert",
      path: appsetsKustomizationPath(env),
      content: removeFromAppsetsKustomization(appsetsKustomization, slug, env),
    },
  ];
  return { kind: "remove", ops, nextEnvs: remaining };
}

function planDecommission(args: {
  slug: string;
  currentEnvs: NodeFormationEnv[];
  current: EnvPlanCurrent;
}): EnvDeltaResult {
  const { slug, currentEnvs, current } = args;
  const ops: EnvPlanOp[] = [];

  // The whole catalog row leaves git.
  ops.push({ op: "delete", path: CATALOG_PATH(slug) });

  // Per-env: delete overlay + appset, regenerate that env's kustomization without the slug.
  for (const env of currentEnvs) {
    const appsetsKustomization = current.appsetsKustomizationByEnv[env];
    if (appsetsKustomization === undefined) {
      throw new EnvPlanError(
        "env_render_inputs_missing",
        `cannot render decommission of '${slug}': missing appsets kustomization for '${env}'.`,
        422
      );
    }
    ops.push({ op: "delete", path: overlayPath(env, slug) });
    ops.push({ op: "delete", path: appsetPath(env, slug) });
    ops.push({
      op: "upsert",
      path: appsetsKustomizationPath(env),
      content: removeFromAppsetsKustomization(appsetsKustomization, slug, env),
    });
  }

  // Env-independent edge/routing state — only touched on a full removal.
  if (current.caddyfile !== undefined) {
    ops.push({
      op: "upsert",
      path: CADDYFILE_PATH,
      content: removeCaddyBlock(current.caddyfile, slug),
    });
  }
  if (current.schedulerConfigmap !== undefined) {
    ops.push({
      op: "upsert",
      path: SCHEDULER_CONFIGMAP_PATH,
      content: removeSchedulerEndpoint(current.schedulerConfigmap, slug),
    });
  }

  return { kind: "decommission", ops, nextEnvs: [] };
}
