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
 * Scope: Composes the byte-exact single-file gens (`setCatalogEnvs`, `setCatalogPlacementCell`, the
 *   scheduler-endpoint splices) over the current contents the adapter fetches on main. NO IO,
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
 *     `compute_api: node-deploy` (story.5137 ONE_WRITER_PER_NODE_LANE, task.5411); no `source_repo`
 *     ⇒ refused (`env_add_requires_source_repo`): an in-repo row has no node-deploy lane. No AppSet,
 *     overlay, ExternalSecret or `lease_generation` is ever written; the verb is the lane's writer.
 *   - REMOVE_COMPLETES_THE_ROW (story.5039 PR-B) — removing an env drops that env's
 *     `deployment_provider`/`compute_api`/`required_placement_countries` cells along with the
 *     `envs:` entry, so the emitted catalog satisfies NO_PLACEMENT_FOR_UNDECLARED_ENV. Removal
 *     deletes the paired aliases from the workload lane and foreign control-worker namespace
 *     (bug.5536). Retiring the running workload is the node-deploy verb's job, never this plan's.
 *   - IDEMPOTENT — requesting the state that already holds (env already present on add / already absent on
 *     remove) yields an EMPTY op list (`{ kind: "no_changes" }`), so the adapter opens no PR.
 *   - PLACEMENT_IS_A_LANE_SWITCH (story.5016 T5) — `buildPlacementPlan` edits ONLY
 *     `deployment_provider.<env>` in the catalog (+ the scheduler-worker routing patch,
 *     PLACEMENT_DECIDES_THE_ADDRESS below). `envs:` and `compute_egress_cidrs` are untouched.
 *   - PLACEMENT_DECIDES_THE_ADDRESS (bug.5094) applies to the placement lever too — the
 *     scheduler-worker's routed URL for `slug` must move with the flip (in-cluster Service DNS ⇄
 *     the node's public host), or the routing map keeps dialing the lane the node just left.
 *   - OPERATOR_SELF_HOSTS_THE_VERB — the operator control plane cannot remove its own deployment from
 *     an env; fail closed (422).
 * Side-effects: none — pure string transforms.
 * Links: src/adapters/server/vcs/github-repo-write.ts (openNodeEnvPr), docs/design/operator-fleet-safety.md, story.5020
 * @public
 */

import {
  controlEnvFor,
  nodeAppBaseUrl,
} from "@/shared/node-registry/placement";

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
  setCatalogActivityEnv,
  setCatalogEnvs,
  setCatalogPlacement,
  setCatalogPlacementCell,
} from "./env-membership";
import type { NodeFormationEnv } from "./envs";
import {
  setCustodiedSchedulerEndpointMembership,
  setSchedulerEndpointMembership,
  updateSchedulerEndpointHost,
} from "./scheduler-endpoints";

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
 * (`FORK_DOMAIN_ROOT:-cognidao.org` in scripts/ci/render-scheduler-worker-endpoints.sh). The planner
 * remains pure: adapters may supply a fleet-specific root, while omission preserves canonical output.
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
  /** Public workload zone for this fleet; omitted preserves the canonical cognidao.org default. */
  readonly publicDomainRoot?: string | undefined;
  /**
   * Current per-env scheduler-worker node-endpoints patch — needed for the placement lever
   * ({@link buildPlacementPlan}) and membership changes (absent aliases are removed). Keyed by
   * env; membership also reads the derived control environment for foreign-lane queue custody.
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
 * OPERATOR_SELF_HOSTS_THE_VERB — the operator app IS the control plane serving this verb; removing
 * its deployment from an env destroys that env's ability to manage itself (and everything else).
 * Its env membership is verb-immutable — fail closed (422). Previously this was only enforced
 * de facto; node-template's guard relaxation makes it explicit.
 */
const OPERATOR_SLUG = "operator";

/**
 * Pure: the control env of an externally built row's lane (bug.5204) — the env whose scheduler
 * worker custodies a non-production akash lane's queue. Only membership routing reads it now.
 */
function nodeDeployControlEnv(
  env: NodeFormationEnv,
  fleetControlEnv?: string
): string {
  return controlEnvFor(env, "akash", fleetControlEnv);
}

/**
 * Pure: compute the file-delta for `{ slug, env, present }` over the node's current control-plane files.
 * Every env is an INDEPENDENT, atomic toggle (ATOMIC_PER_ENV) — candidate-a is no different from
 * preview/production.
 *
 * - ADD (present, env absent): catalog `envs:` += env PLUS `deployment_provider.<env>: akash` and
 *   `compute_api.<env>: node-deploy` (ADD_DERIVES_PLACEMENT, story.5137 ONE_WRITER_PER_NODE_LANE), and
 *   the paired route in the workload lane and any foreign control-worker namespace. No AppSet,
 *   overlay or ExternalSecret is written: the node-deploy verb is the lane's only writer.
 * - REMOVE (¬present, env present): catalog `envs:` −= env AND −= the env's placement cells
 *   (REMOVE_COMPLETES_THE_ROW), and the paired routes leave the workload lane and any foreign
 *   control-worker namespace. Removing the final env or the current activity authority is rejected
 *   with a typed 422. `operator` removes are rejected (OPERATOR_SELF_HOSTS_THE_VERB).
 * - Idempotent: the already-holding state returns `{ kind: "no_changes" }`.
 */
export function buildEnvDeltaPlan(input: {
  readonly slug: string;
  readonly env: NodeFormationEnv;
  readonly present: boolean;
  readonly current: EnvPlanCurrent;
  /**
   * THE FLEET CONTROL ENV (`FLEET_CONTROL_ENV`, `controlEnvFor`) — the env whose scheduler worker
   * custodies an akash non-production lane's queue (bug.5204/bug.5235). Omitted => `production`
   * (cogni-dao fleet); an isolated test fleet passes `candidate-a`.
   */
  readonly fleetControlEnv?: string | undefined;
}): EnvDeltaResult {
  const { slug, env, present, current, fleetControlEnv } = input;

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
      fleetControlEnv,
    });
  }
  return planRemove({
    slug,
    env,
    currentEnvs,
    activityEnv,
    current,
    fleetControlEnv,
  });
}

function planAdd(args: {
  slug: string;
  env: NodeFormationEnv;
  currentEnvs: NodeFormationEnv[];
  activityEnv: NodeFormationEnv;
  current: EnvPlanCurrent;
  fleetControlEnv?: string | undefined;
}): EnvDeltaResult {
  const { slug, env, currentEnvs, activityEnv, current, fleetControlEnv } =
    args;

  // Idempotent: already present → no PR.
  if (currentEnvs.includes(env)) {
    return { kind: "no_changes" };
  }

  // ADD_DERIVES_PLACEMENT — an externally built row (source_repo) is the only node shape a lane
  // can be added for: the node-deploy verb deploys the image that row's own CI built. An in-repo
  // row (the operator) has no node-deploy lane and its env set is not verb-managed.
  if (!hasCatalogSourceRepo(current.catalog)) {
    throw new EnvPlanError(
      "env_add_requires_source_repo",
      `cannot activate '${env}' for '${slug}': the catalog row has no source_repo, so there is no node-deploy lane to add.`,
      422
    );
  }

  const nextEnvs = addCatalogEnv(currentEnvs, env);
  // The authority is the HIGHEST env the node will be deployed to — not merely a comparison
  // against the env being added. Taking the max is monotonic by construction: it never demotes,
  // because the current authority is itself a member of `nextEnvs`.
  const nextActivityEnv = nextEnvs.reduce(
    (highest, candidate) =>
      envRank(candidate) > envRank(highest) ? candidate : highest,
    activityEnv
  );

  // ACTIVITY_FOLLOWS_INGEST — see the module header for why this needs no fenced
  // cutover: only production can ingest, so a sub-production authority is provably
  // empty (bug.5079).
  let nextCatalog = setCatalogEnvs(current.catalog, nextEnvs);
  if (nextActivityEnv !== activityEnv) {
    nextCatalog = setCatalogActivityEnv(nextCatalog, nextActivityEnv);
  }
  // Placement stated EXPLICITLY (ci-cd Axiom 23): akash + the node-deploy verb as the only writer.
  nextCatalog = setCatalogPlacement(nextCatalog, env, "akash");
  nextCatalog = setCatalogPlacementCell(
    nextCatalog,
    "compute_api",
    env,
    "node-deploy"
  );

  const ops: EnvPlanOp[] = [
    { op: "upsert", path: CATALOG_PATH(slug), content: nextCatalog },
  ];
  ops.push(
    ...buildMembershipRoutingOps(
      slug,
      env,
      "akash",
      nodeDeployControlEnv(env, fleetControlEnv),
      true,
      current
    )
  );
  return { kind: "add", ops, nextEnvs };
}

function planRemove(args: {
  slug: string;
  env: NodeFormationEnv;
  currentEnvs: NodeFormationEnv[];
  activityEnv: NodeFormationEnv;
  current: EnvPlanCurrent;
  fleetControlEnv?: string | undefined;
}): EnvDeltaResult {
  const { slug, env, currentEnvs, activityEnv, current, fleetControlEnv } =
    args;

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

  // The routing custodian derives from the PRE-mutation catalog — the placement cells still
  // exist at plan time. An absent cell is the k3s default, whose control env is the workload env.
  const provider: PlacementProvider =
    parseCatalogPlacement(current.catalog)[env] ?? "k3s";
  const controlEnv = controlEnvFor(env, provider, fleetControlEnv);

  // REMOVE_COMPLETES_THE_ROW — the env's placement cells leave WITH the env, or the emitted
  // catalog violates NO_PLACEMENT_FOR_UNDECLARED_ENV (authority pointed at a workload that no
  // longer exists). Cells are dropped only when present, so other envs' cells pass through
  // byte-verbatim. The running workload itself is retired by the node-deploy verb, never here.
  let nextCatalog = setCatalogEnvs(current.catalog, remaining);
  for (const key of CATALOG_PLACEMENT_KEYS) {
    if (parseCatalogPlacementMap(nextCatalog, key)[env] !== undefined) {
      nextCatalog = setCatalogPlacementCell(nextCatalog, key, env, undefined);
    }
  }

  const ops: EnvPlanOp[] = [
    { op: "upsert", path: CATALOG_PATH(slug), content: nextCatalog },
  ];
  ops.push(
    ...buildMembershipRoutingOps(
      slug,
      env,
      provider,
      controlEnv,
      false,
      current
    )
  );
  return { kind: "remove", ops, nextEnvs: remaining };
}

/** Result of {@link buildRegionPlan} — the node-owned region requirement (story.5050). */
export type RegionDeltaResult =
  | { readonly kind: "no_changes" }
  | {
      readonly kind: "set_region";
      readonly ops: readonly EnvPlanOp[];
    };

/**
 * Pure: compute the file-delta for requiring `{ slug, env }` to be placed in `countries`
 * (story.5050) — the region verb on the env verb.
 *
 * WHY THIS IS A VERB AND NOT A CATALOG PR. A node with a geo-fenced outbound dependency cannot
 * satisfy its own product contract from an arbitrary jurisdiction (bug.5270: 200/200 of poly's
 * production CLOB orders were refused 403 from Belgium). Before this, the only way to express that
 * was a hand-edited monorepo catalog PR — so the node could not CHOOSE anything; an operator with
 * repo access chose for it. This makes the choice a repeatable, RBAC-gated, self-serve control
 * whose output is still the same reviewed catalog commit.
 *
 * Invariants:
 *   - REGION_REQUIRES_AKASH: only a marketplace placement screens bids, so the cell is meaningless
 *     on a k3s-placed env and would be desired state nothing enforces. Fail closed.
 *   - REGION_BINDS_ON_THE_NEXT_RELEASE (task.5411): Akash refuses in-place placement change, and the
 *     node-deploy sequencer mints a fresh lease per release, so the requirement binds on the next
 *     `POST /api/v1/deploy/workloads`. No generation counter moves with it.
 *   - EGRESS_COUPLING_OR_REFUSE: the row must already declare `compute_egress_cidrs`, because a
 *     provider admitted by this requirement whose NAT is absent there boots a workload that then
 *     cannot reach the env VM's substrate ports — a mystery outage, not a config error (the
 *     bug.5191 class). Mirrors the same rule in `infra/catalog/_schema.json`.
 *   - NOT_A_GUARANTEE: the screener compares a provider's ADVERTISED/ingress country, which is not
 *     proven to equal the egress identity its workload presents to a third party. This narrows the
 *     candidate pool; only the workload's own outbound probe proves reachability.
 */
export function buildRegionPlan(input: {
  readonly slug: string;
  readonly env: NodeFormationEnv;
  /** ISO 3166-1 alpha-2 codes the workload MAY be placed in. Non-empty. */
  readonly countries: readonly string[];
  readonly current: EnvPlanCurrent;
}): RegionDeltaResult {
  const { slug, env, countries, current } = input;

  if (countries.length === 0) {
    throw new EnvPlanError(
      "region_required",
      `cannot set a placement region for '${env}' on '${slug}': no countries given. Omitting the requirement is how you say unconstrained; an empty set would refuse every bid.`,
      422
    );
  }
  const invalid = countries.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (invalid.length > 0) {
    throw new EnvPlanError(
      "region_invalid",
      `cannot set a placement region for '${env}' on '${slug}': ${invalid.join(", ")} are not ISO 3166-1 alpha-2 country codes.`,
      422
    );
  }
  if (new Set(countries).size !== countries.length) {
    throw new EnvPlanError(
      "region_invalid",
      `cannot set a placement region for '${env}' on '${slug}': duplicate country codes.`,
      422
    );
  }

  const currentEnvs = parseCatalogEnvs(current.catalog);
  if (!currentEnvs.includes(env)) {
    throw new EnvPlanError(
      "env_not_deployed",
      `cannot set a placement region for '${env}' on '${slug}': the node is not deployed to that environment. Add the env first (present:true).`,
      422
    );
  }

  // REGION_REQUIRES_AKASH — a k3s env is served by the in-cluster overlay; no bids are screened,
  // so the cell would be desired state nothing reads.
  if (parseCatalogPlacement(current.catalog)[env] !== "akash") {
    throw new EnvPlanError(
      "region_requires_akash",
      `cannot set a placement region for '${env}' on '${slug}': that env is not placed on akash, and only a marketplace placement screens provider bids. Place it first (placement:"akash").`,
      422
    );
  }

  // EGRESS_COUPLING_OR_REFUSE — see the invariant above.
  if (!/^compute_egress_cidrs:/m.test(current.catalog)) {
    throw new EnvPlanError(
      "region_requires_egress_cidrs",
      `cannot set a placement region for '${env}' on '${slug}': the catalog row declares no compute_egress_cidrs, so a provider this requirement admits could boot and then be unable to reach the environment's substrate ports.`,
      422
    );
  }

  const wanted = [...countries].sort();

  // IDEMPOTENT, COMPARED ON THE PARSED VALUE — never on the serialized file.
  //
  // `setCatalogPlacementCell` rewrites a whole block from its parsed map, which DROPS any comment
  // lines inside that block. So a call requesting the region the row already holds still produces
  // a different string, and a text comparison would read that as a change — a redundant PR that
  // silently deletes the reviewed rationale from the catalog (PR #2496, closed).
  const held = parseCatalogPlacementMap(
    current.catalog,
    "required_placement_countries"
  )[env];
  const heldCountries = (held ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .sort();
  if (
    heldCountries.length === wanted.length &&
    heldCountries.every((c, i) => c === wanted[i])
  ) {
    return { kind: "no_changes" };
  }

  const nextCatalog = setCatalogPlacementCell(
    current.catalog,
    "required_placement_countries",
    env,
    `[${wanted.join(", ")}]`
  );

  return {
    kind: "set_region",
    ops: [{ op: "upsert", path: CATALOG_PATH(slug), content: nextCatalog }],
  };
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
 * K3S_NODE_LANE_RETIRED (task.5411): an externally built node is deployed only by the node-deploy
 * verb on akash, so `k3s` for a `source_repo` row is refused (`k3s_node_lane_retired`). No file
 * besides the catalog line and the scheduler patch is ever touched.
 *
 * `operator` remains placement-immutable (OPERATOR_SELF_HOSTS_THE_VERB) — the control plane cannot
 * move its own deployment off the lane serving this verb.
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

  if (placement === "k3s" && hasCatalogSourceRepo(current.catalog)) {
    throw new EnvPlanError(
      "k3s_node_lane_retired",
      `cannot place '${slug}' on k3s: externally built nodes deploy only through the node-deploy verb on akash (task.5411).`,
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
 * PLACEMENT_DECIDES_THE_ADDRESS (bug.5094): the placement flip decides which address to dial for
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
    apexDomain: current.publicDomainRoot ?? CANONICAL_DOMAIN_ROOT,
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

/** Membership changes must update both the workload lane and its existing queue custodian. */
function buildMembershipRoutingOps(
  slug: string,
  env: NodeFormationEnv,
  provider: PlacementProvider,
  controlEnv: string,
  present: boolean,
  current: EnvPlanCurrent
): EnvPlanOp[] {
  const nodeId = parseCatalogNodeId(current.catalog);
  const url = present
    ? nodeAppBaseUrl({
        slug,
        provider,
        environment: env,
        apexDomain: current.publicDomainRoot ?? CANONICAL_DOMAIN_ROOT,
      })
    : null;
  const ops: EnvPlanOp[] = [];
  for (const target of new Set([env, controlEnv])) {
    const before = current.schedulerEndpointPatchByEnv?.[target];
    if (before === undefined)
      throw new EnvPlanError(
        "env_render_inputs_missing",
        `cannot plan membership routing for '${env}'/'${slug}': missing '${target}' scheduler patch.`,
        422
      );
    const after =
      target === env
        ? setSchedulerEndpointMembership(before, slug, nodeId, url)
        : setCustodiedSchedulerEndpointMembership(
            before,
            env,
            slug,
            nodeId,
            url
          );
    if (after !== before)
      ops.push({
        op: "upsert",
        path: schedulerEndpointPatchPath(target),
        content: after,
      });
  }
  return ops;
}
