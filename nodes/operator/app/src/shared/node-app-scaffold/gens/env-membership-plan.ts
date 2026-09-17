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
 *   - ADD_DERIVES_PLACEMENT (story.5039) — `present:true` DERIVES the env's placement instead of
 *     accepting it as caller input, and the route keeps `present`/`placement` MUTUALLY EXCLUSIVE.
 *     There is no legitimate second answer to derive around: akash requires a `source_repo` (an
 *     external build plane), and a `source_repo`-bearing row left on k3s violates ci-cd Axiom 23
 *     (absent placement is a hard failure, not a k3s fallback). So `source_repo` present ⇒ akash +
 *     `compute_api: crossplane` (policy via `canBirthOnCrossplane`/`writerFor`) + an explicit
 *     `lease_generation` cell; no `source_repo` ⇒ k3s with no cells. The placement verb remains for
 *     LANE MIGRATION of an env already in reach, never for activation.
 *   - CONTROL_ENV_OWNS_THE_APPSET_DIR (bug.5204) — the AppSet filename carries the WORKLOAD env,
 *     its directory the CONTROL env (`controlEnvFor`): an akash node's non-production lane is
 *     reconciled by the PRODUCTION cluster. On ADD it derives from the POST-MUTATION placement —
 *     the add writes catalog + AppSet in one tree, and the pre-mutation catalog reads absent
 *     placement as k3s, i.e. the wrong directory. On REMOVE it derives from the PRE-mutation
 *     catalog — the placement cells still exist at plan time, and they name the directory the
 *     AppSet was written into.
 *   - REMOVE_COMPLETES_THE_ROW (story.5039 PR-B) — removing an env drops that env's
 *     `deployment_provider`/`compute_api`/`lease_generation` cells along with the `envs:` entry,
 *     so the emitted catalog satisfies NO_PLACEMENT_FOR_UNDECLARED_ENV
 *     (tests/ci-invariants/env-declaration-completeness.spec.ts). A stranded cell is authority
 *     pointed at a workload that does not exist — the exact shape the invariant fails CI on.
 *     For an akash lane the remove also restores the env's scheduler-worker route to the k3s
 *     in-cluster default (the byte-inverse of the add's public-host write, bug.5094), so a later
 *     re-add starts from the same bytes a never-removed row has. The CLOSE of the paid lease is
 *     deliberately NOT here: Argo prunes the AppSet → Crossplane observes REMOVE → the actuator
 *     deletes the deployment. This plan only makes the removal COMPLETE in git.
 *   - IDEMPOTENT — requesting the state that already holds (env already present on add / already absent on
 *     remove) yields an EMPTY op list (`{ kind: "no_changes" }`), so the adapter opens no PR.
 *   - DELETE_VIA_SHA_NULL — file removals are emitted as `{ op: "delete", path }`; the adapter maps these
 *     to `{ sha: null }` tree entries (delete-from-base_tree).
 *   - PLACEMENT_IS_A_LANE_SWITCH (story.5016 T5) — `buildPlacementPlan` flips WHICH lane serves an
 *     env the node already deploys to: it edits ONLY `deployment_provider.<env>` in the catalog
 *     (+ the scheduler-worker routing patch, PLACEMENT_DECIDES_THE_ADDRESS below). The overlay,
 *     external-secret, AppSet, and appsets kustomization are ALL untouched — Argo delivers BOTH the
 *     k3s Deployment AND the akash ComputeWorkload CR through the SAME per-node Application; only
 *     the overlay's CONTENT differs, and that swap happens in the materializer on the deploy
 *     branch at the next flight/promote, not in this plan. `envs:` and `compute_egress_cidrs` are
 *     untouched too — placement is a lane switch, not an undeploy (an earlier revision of this
 *     verb copied the env-removal delete ops here; that was wrong — see `buildPlacementPlan`).
 *   - PLACEMENT_DECIDES_THE_ADDRESS (bug.5094) applies to the placement lever too — the
 *     scheduler-worker's routed URL for `slug` must move with the flip (in-cluster Service DNS ⇄
 *     the node's public host), or the routing map keeps dialing the lane the node just left.
 *   - TEMPLATE_OVERLAY_IS_RENDER_SOURCE — node-template's overlay FILES are the per-env render template
 *     every wizard node clones; its DEPLOYMENT is not special. A node-template remove deletes only the
 *     appset (+ kustomization entry + catalog env) and keeps the overlay files in the tree.
 *   - OPERATOR_SELF_HOSTS_THE_VERB — the operator control plane cannot remove its own deployment from
 *     an env; fail closed (422).
 * Side-effects: none — pure string transforms.
 * Links: src/adapters/server/vcs/github-repo-write.ts (openNodeEnvPr), docs/design/operator-fleet-safety.md, story.5020
 * @public
 */

import { canBirthOnCrossplane } from "@/shared/node-registry/crossplane-control-plane";
import {
  controlEnvFor,
  nodeAppBaseUrl,
} from "@/shared/node-registry/placement";

import {
  insertAppsetKustomization,
  removeFromAppsetsKustomization,
  renderNodeAppset,
} from "./appset";
import { githubOwnerFromSourceRepo } from "./catalog";
import {
  addCatalogEnv,
  CATALOG_PLACEMENT_KEYS,
  dropCatalogEnv,
  envRank,
  envRemovalViolation,
  hasCatalogSourceRepo,
  type PlacementProvider,
  parseCatalogActivityEnv,
  parseCatalogEnvs,
  parseCatalogNodeId,
  parseCatalogPlacement,
  parseCatalogPlacementMap,
  parseCatalogSourceRepo,
  setCatalogActivityEnv,
  setCatalogEnvs,
  setCatalogPlacement,
  setCatalogPlacementCell,
} from "./env-membership";
import type { NodeFormationEnv } from "./envs";
import { renderOverlay, renderOverlayFile } from "./overlay";
import { updateSchedulerEndpointHost } from "./scheduler-endpoints";

/** Repo-relative path of a node's per-env overlay kustomization. */
export const overlayPath = (env: string, slug: string): string =>
  `infra/k8s/overlays/${env}/${slug}/kustomization.yaml`;

/** Repo-relative path of a node's per-env ESO producer (creates `<slug>-env-secrets`). */
export const externalSecretPath = (env: string, slug: string): string =>
  `infra/k8s/overlays/${env}/${slug}/external-secret.yaml`;

/**
 * Repo-relative path of a node's per-(env, slug) ApplicationSet object. The FILENAME carries the
 * WORKLOAD env; the DIRECTORY carries the CONTROL env — the cluster that reconciles it
 * (`controlEnvFor`, bug.5204). They differ exactly for an akash node's non-production lane.
 */
export const appsetPath = (
  controlEnv: string,
  workloadEnv: string,
  slug: string
): string =>
  `infra/k8s/argocd/appsets/${controlEnv}/${workloadEnv}-${slug}-applicationset.yaml`;

/** Repo-relative path of ONE CONTROL env's appsets kustomization (the list the pair folds into). */
export const appsetsKustomizationPath = (controlEnv: string): string =>
  `infra/k8s/argocd/appsets/${controlEnv}/kustomization.yaml`;

export const CATALOG_PATH = (slug: string): string =>
  `infra/catalog/${slug}.yaml`;

/**
 * Repo-relative path of ONE env's generated scheduler-worker node-endpoints patch (bug.5094) — the
 * PROVIDER-RESOLVED routing map the placement lever must keep in sync (story.5016 T5 follow-up).
 * Env-invariant across nodes: every placement flip on `env` edits this ONE file.
 */
export const schedulerEndpointPatchPath = (env: string): string =>
  `infra/k8s/overlays/${env}/scheduler-worker/node-endpoints.patch.yaml`;

/**
 * The canonical zone this repo's public hosts hang off, matching the bash renderer's own default
 * (`FORK_DOMAIN_ROOT:-cognidao.org` in scripts/ci/render-scheduler-worker-endpoints.sh). This
 * generator family stays pure (no env access, LAYER_NEUTRAL) — a fork that renamed its zone
 * regenerates this file locally with its own `FORK_DOMAIN_ROOT` export, exactly like the bash twin.
 */
export const CANONICAL_DOMAIN_ROOT = "cognidao.org";

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
  /**
   * Current appsets kustomizations, keyed by CONTROL env (bug.5204) — the adapter fetches the
   * kustomization of the env whose cluster reconciles the AppSet. On ADD that is
   * `planEnvAddShape().controlEnv` (POST-mutation placement); on REMOVE it is `controlEnvFor`
   * over the PRE-mutation catalog's `deployment_provider.<env>` (the cells still exist at plan
   * time). Both are `production` for an akash non-production lane.
   */
  readonly appsetsKustomizationByEnv: Readonly<Record<string, string>>;
  /** Container port + node_port for the overlay render (only needed on ADD). */
  readonly port?: number | undefined;
  readonly nodePort?: number | undefined;
  /**
   * Current per-env scheduler-worker node-endpoints patch — needed for the placement lever
   * ({@link buildPlacementPlan}), an akash-derived ADD (public-host route from the first
   * flight), and an akash REMOVE (in-cluster restore, REMOVE_COMPLETES_THE_ROW). Keyed by
   * env — only the env being mutated is ever read.
   */
  readonly schedulerEndpointPatchByEnv?: Readonly<Record<string, string>>;
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

/** The derived activation shape of one `{env, present:true}` request — see ADD_DERIVES_PLACEMENT. */
export type EnvAddShape =
  /** In-repo k3s lane: no placement cells at all, reconciled by the env's own cluster. */
  | {
      readonly placement: "k3s";
      readonly computeApi: null;
      readonly controlEnv: NodeFormationEnv;
    }
  /** Externally built row: akash placement, crossplane authority, production reconciles non-prod. */
  | {
      readonly placement: "akash";
      readonly computeApi: "crossplane";
      readonly controlEnv: NodeFormationEnv;
    };

/**
 * Pure: derive what activating `env` for this catalog row MEANS (ADD_DERIVES_PLACEMENT,
 * story.5039). `source_repo` present ⇒ the row is externally built and MUST be placed
 * (`akash` + `compute_api: crossplane`); no `source_repo` ⇒ the in-repo k3s lane with no cells.
 *
 * An akash derivation with no resolvable actuator writer throws `compute_authority_unavailable`
 * (422): the catalog schema (infra/catalog/_schema.json allOf) makes an akash env without
 * `compute_api` INVALID, and naming `crossplane` where no writer mints is a workload nobody pays
 * for — either way the verb would author an unmergeable or dead-on-arrival PR. Refuse loudly.
 */
export function planEnvAddShape(
  catalog: string,
  env: NodeFormationEnv
): EnvAddShape {
  if (!hasCatalogSourceRepo(catalog)) {
    // In-repo row: no external artifact plane, so the k3s lane — and no placement cells, which
    // keeps the operator's own row untouchable here (it is add-immutable in practice and
    // remove-immutable via OPERATOR_SELF_HOSTS_THE_VERB).
    return { placement: "k3s", computeApi: null, controlEnv: env };
  }
  const ownerOrg = githubOwnerFromSourceRepo(parseCatalogSourceRepo(catalog));
  if (!canBirthOnCrossplane(env, ownerOrg)) {
    throw new EnvPlanError(
      "compute_authority_unavailable",
      `cannot activate '${env}' for owner org '${ownerOrg}': no Crossplane compute authority resolves ` +
        `(canBirthOnCrossplane requires an installed control plane AND exactly one actuator writer). ` +
        `Fix location: the CROSSPLANE_ACTUATOR_WRITERS map in src/shared/node-registry/crossplane-control-plane.ts.`,
      422
    );
  }
  return {
    placement: "akash",
    computeApi: "crossplane",
    controlEnv: controlEnvFor(env, "akash"),
  };
}

/**
 * Pure: compute the file-delta for `{ slug, env, present }` over the node's current control-plane files.
 * Every env is an INDEPENDENT, atomic toggle (ATOMIC_PER_ENV) — candidate-a is no different from
 * preview/production.
 *
 * - ADD (present, env absent): catalog `envs:` += env PLUS the derived placement cells
 *   (ADD_DERIVES_PLACEMENT), render overlay + appset (under the CONTROL env's dir, bug.5204), fold
 *   the `(env, slug)` pair into that control env's appsets kustomization, and for an akash lane
 *   move the env's scheduler-worker route to the node's public host (bug.5094 — a fresh akash lane
 *   has no `<slug>-node-app` Service to dial).
 * - REMOVE (¬present, env present): catalog `envs:` −= env AND −= the env's placement cells
 *   (REMOVE_COMPLETES_THE_ROW), DELETE the overlay + the appset at its CONTROL-env path, regenerate
 *   that control env's appsets kustomization without the pair, and for an akash lane restore the
 *   env's scheduler-worker route to the in-cluster default. Applies to candidate-a exactly like any
 *   other env.
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
  /** Explicit akash lease replacement counter for the added env (defaults 0 — a fresh lease). */
  readonly leaseGeneration?: number | undefined;
}): EnvDeltaResult {
  const { slug, env, present, current, leaseGeneration } = input;

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
    return planAdd({
      slug,
      env,
      currentEnvs,
      activityEnv,
      current,
      leaseGeneration,
    });
  }
  return planRemove({ slug, env, currentEnvs, activityEnv, current });
}

function planAdd(args: {
  slug: string;
  env: NodeFormationEnv;
  currentEnvs: NodeFormationEnv[];
  activityEnv: NodeFormationEnv;
  current: EnvPlanCurrent;
  leaseGeneration?: number | undefined;
}): EnvDeltaResult {
  const { slug, env, currentEnvs, activityEnv, current, leaseGeneration } =
    args;

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

  // ADD_DERIVES_PLACEMENT — the shape (placement + compute authority + control env) is a function
  // of the catalog row, never caller input. Throws compute_authority_unavailable before any render.
  const shape = planEnvAddShape(current.catalog, env);

  const templateOverlay = current.templateOverlayByEnv[env];
  const templateExternalSecret = current.templateExternalSecretByEnv?.[env];
  const appsetsKustomization =
    current.appsetsKustomizationByEnv[shape.controlEnv];
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
      `cannot render add of '${env}' for '${slug}': missing template overlay, external-secret, appset template, control-env ('${shape.controlEnv}') kustomization, or ports.`,
      422
    );
  }

  // ACTIVITY_FOLLOWS_INGEST — see the module header for why this needs no fenced
  // cutover: only production can ingest, so a sub-production authority is provably
  // empty. Without this, a promoted node is deployed and serving yet structurally
  // unable to earn a receipt — its webhooks land in production and are dropped
  // `unclaimed`, fail-closed and silent. That is bug.5079, which left `levelup` live
  // in production with zero receipts.
  let nextCatalog = setCatalogEnvs(current.catalog, nextEnvs);
  if (nextActivityEnv !== activityEnv) {
    nextCatalog = setCatalogActivityEnv(nextCatalog, nextActivityEnv);
  }
  if (shape.placement === "akash") {
    // The three cells #2301 hand-wrote, EXPLICITLY — including a schema-default
    // `lease_generation: 0`. Activation states its placement in git; eliding a default here
    // is exactly the silent k3s fallback ci-cd Axiom 23 forbids.
    nextCatalog = setCatalogPlacement(nextCatalog, env, "akash");
    nextCatalog = setCatalogPlacementCell(
      nextCatalog,
      "compute_api",
      env,
      shape.computeApi
    );
    nextCatalog = setCatalogPlacementCell(
      nextCatalog,
      "lease_generation",
      env,
      String(leaseGeneration ?? 0)
    );
  }

  const ops: EnvPlanOp[] = [
    {
      op: "upsert",
      path: CATALOG_PATH(slug),
      content: nextCatalog,
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
    // CONTROL_ENV_OWNS_THE_APPSET_DIR (bug.5204) — the dir comes from the POST-MUTATION
    // placement; the filename keeps the workload env.
    {
      op: "upsert",
      path: appsetPath(shape.controlEnv, env, slug),
      content: renderNodeAppset(current.appsetTemplate, slug, env),
    },
    {
      op: "upsert",
      path: appsetsKustomizationPath(shape.controlEnv),
      content: insertAppsetKustomization(appsetsKustomization, slug, env),
    },
  ];
  if (shape.placement === "akash") {
    // PLACEMENT_DECIDES_THE_ADDRESS (bug.5094) at activation: an akash lane has no
    // `<slug>-node-app` Service, so the env's scheduler-worker route must carry the node's
    // public host from the very first flight. A k3s add needs no op — every env patch already
    // renders the in-cluster default for every catalog row.
    const schedulerOp = buildSchedulerEndpointOp(slug, env, "akash", current);
    if (schedulerOp) ops.push(schedulerOp);
  }
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

  // CONTROL_ENV_OWNS_THE_APPSET_DIR on the remove side: derived from the PRE-mutation catalog —
  // the placement cells still exist at plan time, and they name the directory the AppSet was
  // written into. An absent cell is the k3s default, whose control env is the workload env.
  const provider: PlacementProvider =
    parseCatalogPlacement(current.catalog)[env] ?? "k3s";
  const controlEnv = controlEnvFor(env, provider);

  const appsetsKustomization = current.appsetsKustomizationByEnv[controlEnv];
  if (appsetsKustomization === undefined) {
    throw new EnvPlanError(
      "env_render_inputs_missing",
      `cannot render remove of '${env}' for '${slug}': missing control-env ('${controlEnv}') appsets kustomization.`,
      422
    );
  }

  // REMOVE_COMPLETES_THE_ROW — the env's placement cells leave WITH the env, or the emitted
  // catalog violates NO_PLACEMENT_FOR_UNDECLARED_ENV (authority pointed at a workload that no
  // longer exists). Cells are dropped only when present, so a cell-less (k3s) row's placement
  // blocks — including other envs' cells — pass through byte-verbatim.
  let nextCatalog = setCatalogEnvs(current.catalog, remaining);
  for (const key of CATALOG_PLACEMENT_KEYS) {
    if (parseCatalogPlacementMap(nextCatalog, key)[env] !== undefined) {
      nextCatalog = setCatalogPlacementCell(nextCatalog, key, env, undefined);
    }
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
      content: nextCatalog,
    },
    ...(keepOverlayFiles
      ? []
      : ([
          { op: "delete", path: overlayPath(env, slug) },
          { op: "delete", path: externalSecretPath(env, slug) },
        ] as const)),
    // Deleted at its CONTROL-env path — the dir the add wrote it into (parity with planAdd;
    // PR-A left this env-keyed, which stranded an akash lane's AppSet under appsets/production/).
    { op: "delete", path: appsetPath(controlEnv, env, slug) },
    {
      op: "upsert",
      path: appsetsKustomizationPath(controlEnv),
      content: removeFromAppsetsKustomization(appsetsKustomization, slug, env),
    },
  ];
  if (provider === "akash") {
    // PLACEMENT_DECIDES_THE_ADDRESS (bug.5094), inverted: the akash add moved this env's
    // scheduler-worker route to the node's public host; the remove restores the k3s in-cluster
    // default (`http://<slug>-node-app:3000`) so the routing map never keeps dialing a host
    // whose lease the Argo→Crossplane chain is about to close. Byte-inverse of planAdd's write;
    // idempotent when the route is already in-cluster.
    const schedulerOp = buildSchedulerEndpointOp(slug, env, "k3s", current);
    if (schedulerOp) ops.push(schedulerOp);
  }
  return { kind: "remove", ops, nextEnvs: remaining };
}

export type PlacementDeltaResult =
  | { readonly kind: "no_changes" }
  | {
      readonly kind: "place_akash" | "place_k3s";
      readonly ops: readonly EnvPlanOp[];
    };

/**
 * Pure: compute the file-delta for placing `{ slug, env }` on `placement` (story.5016 T5) — the
 * placement lever on the env verb. Placement is a property of an env the node is ALREADY deployed
 * to (`envs:` is untouched); it decides WHICH lane serves that deployment:
 *
 * - `akash`: upsert `deployment_provider.<env>: akash` in the catalog.
 * - `k3s`: drop the env's `deployment_provider` entry (k3s is the schema default).
 *
 * NO_DELETE_ON_PLACEMENT (story.5016 T5 correction — an earlier revision of this verb wrongly
 * copied `planRemove`'s delete set here): the overlay, external-secret, AppSet, and appsets
 * kustomization are NEVER touched by a placement flip. Argo delivers BOTH the k3s Deployment and
 * the akash ComputeWorkload CR through the SAME per-node Application (proof: toks4's candidate-a/
 * preview/production AppSets all exist today, fully akash-placed) — the overlay's CONTENT differs
 * per placement, but that swap is the materializer's job on the deploy branch at the next
 * flight/promote, not this plan's. Deleting the AppSet here (the earlier revision's bug) orphaned
 * the Application Argo needs to deliver the ComputeWorkload CR in the first place, and deleting the
 * overlay/external-secret left nothing for the materializer to swap content INTO.
 *
 * `operator` remains placement-immutable (OPERATOR_SELF_HOSTS_THE_VERB) — the control plane cannot
 * move its own deployment off the lane serving this verb. `node-template` places like any ordinary
 * externally-built node; TEMPLATE_OVERLAY_IS_RENDER_SOURCE has nothing to special-case here now
 * that placement deletes nothing.
 *
 * {@link buildSchedulerEndpointOp} is the ONE real side effect beyond the catalog line
 * (PLACEMENT_DECIDES_THE_ADDRESS, bug.5094): the scheduler-worker's routed URL for `slug` in `env`
 * moves with the flip. IDEMPOTENT + per-env atomic — the already-holding state (catalog already
 * says `placement`, routing already resolved) is `no_changes`.
 */
export function buildPlacementPlan(input: {
  readonly slug: string;
  readonly env: NodeFormationEnv;
  readonly placement: PlacementProvider;
  readonly current: EnvPlanCurrent;
}): PlacementDeltaResult {
  const { slug, env, placement, current } = input;

  // OPERATOR_SELF_HOSTS_THE_VERB — the control plane cannot move its own deployment off the lane
  // serving this verb. Fail closed.
  if (placement === "akash" && slug === OPERATOR_SLUG) {
    throw new EnvPlanError(
      "operator_node_immutable",
      `'${OPERATOR_SLUG}' is the control plane serving this verb; it cannot be placed off k3s.`,
      422
    );
  }

  const currentEnvs = parseCatalogEnvs(current.catalog);
  if (!currentEnvs.includes(env)) {
    throw new EnvPlanError(
      "env_not_deployed",
      `cannot set placement for '${env}' on '${slug}': the node is not deployed to that environment. Add the env first (present:true).`,
      422
    );
  }

  // AKASH_NEEDS_BUILD_PLANE — the CR lane resolves image_repository:sha-<sourceSha> from an
  // external source_repo; an in-repo node has no such artifact plane and CANNOT run on akash.
  if (placement === "akash" && !hasCatalogSourceRepo(current.catalog)) {
    throw new EnvPlanError(
      "akash_requires_source_repo",
      `cannot place '${slug}' on akash: the catalog row has no source_repo (external build plane). Only externally-built nodes can run on decentralized compute.`,
      422
    );
  }

  const nextCatalog = setCatalogPlacement(current.catalog, env, placement);

  const ops: EnvPlanOp[] = [];
  if (nextCatalog !== current.catalog) {
    ops.push({ op: "upsert", path: CATALOG_PATH(slug), content: nextCatalog });
  }
  const schedulerOp = buildSchedulerEndpointOp(slug, env, placement, current);
  if (schedulerOp) ops.push(schedulerOp);

  if (ops.length === 0) {
    return { kind: "no_changes" };
  }
  return { kind: placement === "akash" ? "place_akash" : "place_k3s", ops };
}

/**
 * PLACEMENT_DECIDES_THE_ADDRESS (bug.5094) applies to the placement lever AND the akash-derived
 * add (story.5039): the flip/activation decides WHICH address the scheduler-worker must dial for
 * `slug` in `env`, so the env's generated node-endpoints patch has to move with it — else the
 * routing map keeps pointing at the LANE THE NODE JUST LEFT (or, on activation, at a Service that
 * never exists). Returns `null` when the routed URL already matches (idempotent — a catalog-only
 * normalization, or an already-correct restore, opens no scheduler-routing hunk).
 */
function buildSchedulerEndpointOp(
  slug: string,
  env: NodeFormationEnv,
  placement: PlacementProvider,
  current: EnvPlanCurrent
): EnvPlanOp | null {
  const currentPatch = current.schedulerEndpointPatchByEnv?.[env];
  if (currentPatch === undefined) {
    throw new EnvPlanError(
      "env_render_inputs_missing",
      `cannot plan scheduler routing for '${env}'/'${slug}': missing the current node-endpoints patch.`,
      422
    );
  }
  const nodeId = parseCatalogNodeId(current.catalog);
  const url = nodeAppBaseUrl({
    slug,
    provider: placement,
    environment: env,
    apexDomain: CANONICAL_DOMAIN_ROOT,
  });
  const nextPatch = updateSchedulerEndpointHost(
    currentPatch,
    slug,
    nodeId,
    url
  );
  if (nextPatch === currentPatch) return null;
  return {
    op: "upsert",
    path: schedulerEndpointPatchPath(env),
    content: nextPatch,
  };
}
