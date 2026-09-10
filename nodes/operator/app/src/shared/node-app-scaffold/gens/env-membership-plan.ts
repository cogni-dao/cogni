// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/env-membership-plan`
 * Purpose: Pure delta-planner for the node env-membership verb (story.5020 W4). Given a node's CURRENT
 *   committed control-plane files + a requested `{env, present}` mutation, return the exact set of file
 *   upserts/deletes the operator must commit — WITHOUT touching GitHub. The adapter
 *   ({@link GitHubRepoWriter.openNodeEnvPr}) turns each `upsert` into a blob + each `delete` into a
 *   `sha:null` tree entry; this module owns ALL the add/remove branching so it is unit-testable without
 *   Octokit.
 * Scope: Composes the byte-exact single-file gens (`setCatalogEnvs`, `renderOverlay`, `renderNodeAppset`,
 *   `insert/removeFromAppsetsKustomization`) over the current contents the adapter fetches on main. NO IO,
 *   NO env, NO blob SHAs — the adapter resolves those.
 * Invariants:
 *   - NONEMPTY_DEPLOY_SET — removing an env drops just that env, but removing the final env is rejected;
 *     full decommission is a separate lifecycle operation.
 *   - ACTIVITY_AUTHORITY_STAYS_DEPLOYED — removing the current `activity_env` is rejected. V1 does not
 *     claim an atomic cross-environment authority transfer; that needs a future fenced protocol.
 *   - ACTIVITY_FOLLOWS_INGEST — a promotion carries the activity authority with it: `activity_env`
 *     becomes the highest env the node will be deployed to. Webhooks reach production ONLY, and the
 *     receiving operator routes a repo only when `activityEnv === DEPLOY_ENVIRONMENT`, so a promoted
 *     node that keeps a lower authority can never earn a receipt (bug.5079).
 *
 *     WHY THIS IS SAFE WITHOUT THE DEFERRED FENCED CUTOVER: the protocol was deferred because moving
 *     authority could strand a ledger. It cannot here — production is the only env that can ingest a
 *     Git receipt, so any authority BELOW production has an empty Git ledger by construction. There is
 *     nothing to strand. This reasoning is load-bearing: if webhooks are ever delivered to more than
 *     one environment, this move stops being safe and the fenced protocol becomes required. Removing
 *     the active authority stays rejected (ACTIVITY_AUTHORITY_STAYS_DEPLOYED) — that direction CAN
 *     strand a production ledger, and this change does not touch it.
 *
 *     Known cosmetic residue: a node may hold an empty scheduled epoch in its old authority env, which
 *     is orphaned by the move. It carries no receipts and no value (bug.5079).
 *   - IDEMPOTENT — requesting the state that already holds (env already present on add / already absent on
 *     remove) yields an EMPTY op list (`{ kind: "no_changes" }`), so the adapter opens no PR.
 *   - DELETE_VIA_SHA_NULL — file removals are emitted as `{ op: "delete", path }`; the adapter maps these
 *     to `{ sha: null }` tree entries (delete-from-base_tree).
 *   - TEMPLATE_OVERLAY_IS_RENDER_SOURCE — node-template's overlay FILES are the per-env render template
 *     every wizard node clones; its DEPLOYMENT is not special. A node-template remove deletes only the
 *     appset (+ kustomization entry + catalog env) and keeps the overlay files in the tree.
 *   - OPERATOR_SELF_HOSTS_THE_VERB — the operator control plane cannot remove its own deployment from
 *     an env; fail closed (422).
 * Side-effects: none — pure string transforms.
 * Links: src/adapters/server/vcs/github-repo-write.ts (openNodeEnvPr), docs/design/operator-fleet-safety.md, story.5020
 * @public
 */

import {
  insertAppsetKustomization,
  removeFromAppsetsKustomization,
  renderNodeAppset,
} from "./appset";
import {
  addCatalogEnv,
  dropCatalogEnv,
  envRank,
  envRemovalViolation,
  parseCatalogActivityEnv,
  parseCatalogEnvs,
  setCatalogActivityEnv,
  setCatalogEnvs,
} from "./env-membership";
import type { NodeFormationEnv } from "./envs";
import { renderOverlay, renderOverlayFile } from "./overlay";

/** Repo-relative path of a node's per-env overlay kustomization. */
export const overlayPath = (env: string, slug: string): string =>
  `infra/k8s/overlays/${env}/${slug}/kustomization.yaml`;

/** Repo-relative path of a node's per-env ESO producer (creates `<slug>-env-secrets`). */
export const externalSecretPath = (env: string, slug: string): string =>
  `infra/k8s/overlays/${env}/${slug}/external-secret.yaml`;

/** Repo-relative path of a node's per-(env, slug) ApplicationSet object. */
export const appsetPath = (env: string, slug: string): string =>
  `infra/k8s/argocd/appsets/${env}/${env}-${slug}-applicationset.yaml`;

/** Repo-relative path of ONE env's appsets kustomization (the list the slug folds into). */
export const appsetsKustomizationPath = (env: string): string =>
  `infra/k8s/argocd/appsets/${env}/kustomization.yaml`;

export const CATALOG_PATH = (slug: string): string =>
  `infra/catalog/${slug}.yaml`;

/** A single file mutation in the plan. `upsert` carries content; `delete` removes the path. */
export type EnvPlanOp =
  | { readonly op: "upsert"; readonly path: string; readonly content: string }
  | { readonly op: "delete"; readonly path: string };

/**
 * The current committed contents the planner reads. The adapter fetches each on main and passes them in;
 * per-env maps are keyed by env.
 */
export interface EnvPlanCurrent {
  /** Current `infra/catalog/<slug>.yaml` body on main. */
  readonly catalog: string;
  /** The `node-template` overlay for an env being ADDED (source to clone). Keyed by env. */
  readonly templateOverlayByEnv: Readonly<Record<string, string>>;
  /** The `node-template` overlay's `external-secret.yaml` for an env being ADDED (source to clone). Keyed by env. */
  readonly templateExternalSecretByEnv?: Readonly<Record<string, string>>;
  /** The shared `node-applicationset.yaml.tmpl` (only needed on ADD). */
  readonly appsetTemplate?: string | undefined;
  /** Current `appsets/<env>/kustomization.yaml` per env. Keyed by env. */
  readonly appsetsKustomizationByEnv: Readonly<Record<string, string>>;
  /** Container port + node_port for the overlay render (only needed on ADD). */
  readonly port?: number | undefined;
  readonly nodePort?: number | undefined;
}

export type EnvDeltaResult =
  | { readonly kind: "no_changes" }
  | {
      readonly kind: "add" | "remove";
      readonly ops: readonly EnvPlanOp[];
      /** The node's non-empty env-set AFTER the mutation. */
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
 * TEMPLATE_OVERLAY_IS_RENDER_SOURCE — `node-template`'s per-env overlay FILES
 * (`infra/k8s/overlays/<env>/node-template/{kustomization,external-secret}.yaml`) are the render
 * template every wizard node's overlay is cloned from (gens/overlay.ts, render-node-overlays.sh).
 * The FILES are load-bearing; the DEPLOYMENT is not special. So node-template's env membership is
 * an ordinary toggle, except a remove emits a REDUCED delete set: the appset leaves git (Argo
 * prunes the workload) while the overlay files STAY in the tree as pure render-template artifacts.
 * No Application references an overlay dir that has no appset, so keeping the files is inert.
 */
const TEMPLATE_SLUG = "node-template";

/**
 * OPERATOR_SELF_HOSTS_THE_VERB — the operator app IS the control plane serving this verb; removing
 * its deployment from an env destroys that env's ability to manage itself (and everything else).
 * Its env membership is verb-immutable — fail closed (422). Previously this was only enforced
 * de facto; node-template's guard relaxation makes it explicit.
 */
const OPERATOR_SLUG = "operator";

/**
 * Pure: compute the file-delta for `{ slug, env, present }` over the node's current control-plane files.
 * Every env is an INDEPENDENT, atomic toggle (ATOMIC_PER_ENV) — candidate-a is no different from
 * preview/production.
 *
 * - ADD (present, env absent): catalog `envs:` += env, render overlay + appset, fold slug into that env's
 *   appsets kustomization.
 * - REMOVE (¬present, env present): catalog `envs:` −= env, DELETE the overlay + appset, regenerate that
 *   env's appsets kustomization without the slug. Applies to candidate-a exactly like any other env.
 *   Removing the final env or the current activity authority is rejected with a typed 422.
 *   `node-template` removes emit a REDUCED delete set (TEMPLATE_OVERLAY_IS_RENDER_SOURCE): its overlay
 *   files stay in the tree as the render template; only the appset + kustomization entry + catalog env
 *   leave. `operator` removes are rejected (OPERATOR_SELF_HOSTS_THE_VERB).
 * - Idempotent: the already-holding state returns `{ kind: "no_changes" }`.
 */
export function buildEnvDeltaPlan(input: {
  readonly slug: string;
  readonly env: NodeFormationEnv;
  readonly present: boolean;
  readonly current: EnvPlanCurrent;
}): EnvDeltaResult {
  const { slug, env, present, current } = input;

  // OPERATOR_SELF_HOSTS_THE_VERB — the control plane cannot remove its own deployment.
  if (!present && slug === OPERATOR_SLUG) {
    throw new EnvPlanError(
      "operator_node_immutable",
      `'${OPERATOR_SLUG}' is the control plane serving this verb; it cannot remove its own deployment from an env.`,
      422
    );
  }

  const currentEnvs = parseCatalogEnvs(current.catalog);
  const activityEnv = parseCatalogActivityEnv(current.catalog);

  if (present) {
    return planAdd({ slug, env, currentEnvs, activityEnv, current });
  }
  return planRemove({ slug, env, currentEnvs, activityEnv, current });
}

function planAdd(args: {
  slug: string;
  env: NodeFormationEnv;
  currentEnvs: NodeFormationEnv[];
  activityEnv: NodeFormationEnv;
  current: EnvPlanCurrent;
}): EnvDeltaResult {
  const { slug, env, currentEnvs, activityEnv, current } = args;

  // Idempotent: already present → no PR.
  if (currentEnvs.includes(env)) {
    return { kind: "no_changes" };
  }

  const nextEnvs = addCatalogEnv(currentEnvs, env);
  // The authority is the HIGHEST env the node will be deployed to — not merely a comparison
  // against the env being added. Comparing against the added env alone moves a node that is
  // already in production down to `preview` when preview is added later, which still cannot
  // ingest. Taking the max is monotonic by construction: it never demotes, because the
  // current authority is itself a member of `nextEnvs`.
  const nextActivityEnv = nextEnvs.reduce(
    (highest, candidate) =>
      envRank(candidate) > envRank(highest) ? candidate : highest,
    activityEnv
  );

  const templateOverlay = current.templateOverlayByEnv[env];
  const templateExternalSecret = current.templateExternalSecretByEnv?.[env];
  const appsetsKustomization = current.appsetsKustomizationByEnv[env];
  if (
    templateOverlay === undefined ||
    templateExternalSecret === undefined ||
    appsetsKustomization === undefined ||
    current.appsetTemplate === undefined ||
    current.port === undefined ||
    current.nodePort === undefined
  ) {
    throw new EnvPlanError(
      "env_render_inputs_missing",
      `cannot render add of '${env}' for '${slug}': missing template overlay, external-secret, appset template, kustomization, or ports.`,
      422
    );
  }

  const ops: EnvPlanOp[] = [
    {
      op: "upsert",
      path: CATALOG_PATH(slug),
      // ACTIVITY_FOLLOWS_INGEST — see the module header for why this needs no fenced
      // cutover: only production can ingest, so a sub-production authority is provably
      // empty. Without this, a promoted node is deployed and serving yet structurally
      // unable to earn a receipt — its webhooks land in production and are dropped
      // `unclaimed`, fail-closed and silent. That is bug.5079, which left `levelup` live
      // in production with zero receipts.
      content:
        nextActivityEnv === activityEnv
          ? setCatalogEnvs(current.catalog, nextEnvs)
          : setCatalogActivityEnv(
              setCatalogEnvs(current.catalog, nextEnvs),
              nextActivityEnv
            ),
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
    // ESO producer of <slug>-env-secrets — without it the pod's envFrom secret never
    // exists (CreateContainerConfigError). Byte-exact clone of the node-template overlay's
    // external-secret.yaml (render-node-overlays.sh render_file twin).
    {
      op: "upsert",
      path: externalSecretPath(env, slug),
      content: renderOverlayFile(
        templateExternalSecret,
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
  activityEnv: NodeFormationEnv;
  current: EnvPlanCurrent;
}): EnvDeltaResult {
  const { slug, env, currentEnvs, activityEnv, current } = args;

  // Idempotent: already absent → no PR.
  if (!currentEnvs.includes(env)) {
    return { kind: "no_changes" };
  }

  const violation = envRemovalViolation({
    currentEnvs,
    activityEnv,
    removeEnv: env,
  });
  if (violation === "final_environment_required") {
    throw new EnvPlanError(
      violation,
      `cannot remove '${env}' from '${slug}': every node must remain deployed in at least one environment. Use the decommission lifecycle to remove the node.`,
      422
    );
  }
  if (violation === "activity_authority_cutover_required") {
    throw new EnvPlanError(
      violation,
      `cannot remove activity authority '${env}' from '${slug}': v1 has no safe cross-environment cutover.`,
      422
    );
  }

  const remaining = dropCatalogEnv(currentEnvs, env);

  const appsetsKustomization = current.appsetsKustomizationByEnv[env];
  if (appsetsKustomization === undefined) {
    throw new EnvPlanError(
      "env_render_inputs_missing",
      `cannot render remove of '${env}' for '${slug}': missing appsets kustomization.`,
      422
    );
  }
  // TEMPLATE_OVERLAY_IS_RENDER_SOURCE — node-template's overlay files are the render template every
  // wizard node clones, so its remove keeps them in the tree and deletes only the deployment (appset
  // + kustomization entry + catalog env). With no appset, no Application references the files: Argo
  // prunes the workload and the files become pure render-source artifacts.
  const keepOverlayFiles = slug === TEMPLATE_SLUG;
  const ops: EnvPlanOp[] = [
    {
      op: "upsert",
      path: CATALOG_PATH(slug),
      content: setCatalogEnvs(current.catalog, remaining),
    },
    ...(keepOverlayFiles
      ? []
      : ([
          { op: "delete", path: overlayPath(env, slug) },
          { op: "delete", path: externalSecretPath(env, slug) },
        ] as const)),
    { op: "delete", path: appsetPath(env, slug) },
    {
      op: "upsert",
      path: appsetsKustomizationPath(env),
      content: removeFromAppsetsKustomization(appsetsKustomization, slug, env),
    },
  ];
  return { kind: "remove", ops, nextEnvs: remaining };
}
