// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/akash-lane-host`
 * Purpose: RECONCILIATION_FOLLOWS_PAYMENT (story.5016 seam 3) — the ONE reviewed
 *   `lane → hosting cluster` map. It answers a single question: for a given
 *   `(node, environment)` cell, WHICH environment's cluster runs the Argo that reconciles
 *   that cell's `XComputeWorkload`.
 * Scope: Pure policy over two catalog cells (`deployment_provider.<env>`, `compute_api.<env>`).
 *   No I/O, no env read, no cluster contact. The map is asserted against git by
 *   `tests/ci-invariants/akash-lane-host.spec.ts`, which fails CI the moment the committed
 *   AppSet layout and this function disagree in either direction.
 *
 * ## The three axes, and the one this moves
 *
 * The Akash north star (`knowledge:akash-actuator-wallet-cutover`) separates CONTROL (which API
 * a developer drives), RECONCILIATION (which cluster's Crossplane owns desired state and dials
 * the writer) and PAYMENT (which Console account is charged). This module moves RECONCILIATION
 * and NOTHING else:
 *
 *   - `spec.environment` is untouched — a `candidate-a` lane stays `candidate-a`.
 *   - the destination namespace is untouched — still `cogni-<env>`.
 *   - the deploy branch and overlay path are untouched — still `deploy/<env>-<node>` /
 *     `infra/k8s/overlays/<env>/<node>`.
 *
 * So the Composition's two identity gates (`metadata.name == spec.nodeId` and
 * `cogni-<spec.environment> == metadata.namespace`) are satisfied by exactly the same rendered
 * object as before. NEITHER gate mentions a cluster, which is why seam 3 needs no Composition
 * edit at all. The only thing that changes is which cluster's Argo holds the ApplicationSet.
 *
 * ## Why payment drags reconciliation with it
 *
 * `infra/crossplane/xcomputeworkload/composition.yaml` builds the writer's address from the
 * XR's OWN namespace (`akash-tx-actuator.<ns>.svc.cluster.local`) and the writer is ClusterIP,
 * private by construction — so a Crossplane instance can only ever reach a writer in its own
 * cluster. NS3 says every real node deployment in EVERY environment bills the ONE production
 * Console account, and one account admits exactly one active writer
 * (`akash_tx_allocations_single_writer_idx` is a PER-DATABASE partial unique index, so two
 * writers on one account cannot serialize and a retry can pay twice). Therefore the cluster
 * that reconciles a paid lane must be the cluster that hosts the single writer: production.
 *
 * ## Custody flows DOWN-TRUST, one direction only
 *
 * The production cluster hosting a `cogni-candidate-a` lane is acceptable — a production
 * compromise already yields the Console key and the whole fleet. The inverse — the production
 * Console key placed in a candidate-a or preview CLUSTER — is REJECTED: those clusters run
 * unmerged control-plane trees by design. That is why this function only ever routes cells
 * UPWARD to {@link AKASH_LANE_HOST_ENV} and never routes a production cell anywhere else.
 *
 * Invariants:
 *   - ONE_CLUSTER_PER_CELL: exactly one cluster reconciles a given `(node, env)` cell. A hosted
 *     cell's AppSet leaves `appsets/<env>/` in the SAME commit it appears under
 *     {@link HOSTED_LANE_APPSETS_DIR}, so the pre-prod cluster's app-of-apps prunes it. Two
 *     clusters reconciling one XR would be two writers minting under the same idempotence key
 *     against one account — the double-spend this whole design exists to prevent.
 *   - K3S_IS_UNTOUCHED: the predicate requires BOTH `akash` placement AND the `crossplane`
 *     authority. Every k3s row, and every akash row still on the retiring bespoke controller,
 *     routes to its own environment exactly as before — byte-identical rendering, byte-identical
 *     delivery.
 *   - PRODUCTION_DELIVERY_IS_UNCHANGED: a `production` cell is never rehomed (it is already
 *     where the writer is), so `appsets/production/` keeps exactly the files it had.
 * Side-effects: none (pure)
 * Links: infra/k8s/argocd/control-plane/production/production-hosted-lane-appsets-application.yaml,
 *   infra/k8s/overlays/production/akash-lanes/ (seam 4), scripts/ci/render-node-appset.sh,
 *   src/shared/node-app-scaffold/gens/appset.ts, tests/ci-invariants/akash-lane-host.spec.ts,
 *   knowledge:akash-actuator-wallet-cutover, story.5016
 * @public
 */

/**
 * The environment whose cluster hosts every paid Akash lane — the cluster that runs the ONE
 * production `akash-tx-actuator` and holds the production Console credential.
 *
 * It is a constant rather than a parameter on purpose: a second hosting cluster would be a
 * second writer on one account, and that is the forbidden shape. There is no "which host" to
 * choose, only "is this cell hosted".
 *
 * DELIVERY AND PAYMENT MUST AGREE, AND CI ENFORCES IT. The payment half of this decision is the
 * reviewed `writerFor(env) -> writer` map in `./crossplane-control-plane`
 * (`CROSSPLANE_ACTUATOR_WRITERS`, bug.5187), whose `serves` list says WHICH writer mints an
 * environment's leases. This module is the DELIVERY half: which cluster's Argo holds the
 * ApplicationSet. They are separate edits because they are separate decisions — but they may
 * never disagree, so `tests/ci-invariants/akash-lane-host.spec.ts` asserts that every cell this
 * module routes here is also a cell the production writer `serves`.
 *
 * Consequence, stated plainly: landing this module activates NOTHING on its own. The first
 * hosted lane needs BOTH its catalog cell (`deployment_provider`/`compute_api`) AND the
 * production writer's `serves` list widened to that environment. Either alone turns CI red,
 * which is the point — a paid lane whose delivery and payment disagree is the double-spend
 * shape.
 */
export const AKASH_LANE_HOST_ENV = "production";

/**
 * The directory under `infra/k8s/argocd/appsets/` that holds the per-`(env, node)` AppSets the
 * PRODUCTION cluster reconciles on behalf of ANOTHER environment.
 *
 * Deliberately NOT `appsets/production/`. That directory is owned by `cogni-production-appsets`,
 * whose own header states it "can never fan a foreign env's AppSets onto the production
 * cluster" — an invariant worth keeping literally true. Hosted lanes are a separate, explicitly
 * named, separately reviewable exception with its own Application, so the fan-out is auditable
 * from the file tree instead of hidden inside a directory that claims it cannot happen.
 */
export const HOSTED_LANE_APPSETS_DIR = "production-hosted-lanes";

/** Placement lane for one `(node, env)` cell — mirrors `deployment_provider.<env>`. */
export type LanePlacementProvider = "akash" | "k3s";

/** Reconciliation authority for one `(node, env)` cell — mirrors `compute_api.<env>`. */
export type LaneComputeApi = "crossplane" | "legacy";

export interface AkashLaneCell {
  /** The lane's own environment — `spec.environment`, and the `cogni-<env>` namespace. */
  readonly environment: string;
  /** Resolved `deployment_provider.<env>` (K3S_IS_DEFAULT already applied). */
  readonly deploymentProvider: LanePlacementProvider;
  /** Resolved `compute_api.<env>` (LEGACY_IS_DEFAULT already applied). */
  readonly computeApi: LaneComputeApi;
}

/**
 * Is this cell a paid Crossplane Akash lane that the PRODUCTION cluster must reconcile on
 * another environment's behalf?
 *
 * True iff all three hold: the cell is akash-placed, it is owned by the `crossplane` authority
 * (the only authority whose writer address is namespace-derived and therefore cluster-bound),
 * and its environment is not already {@link AKASH_LANE_HOST_ENV}.
 */
export function isHostedAkashLane(cell: AkashLaneCell): boolean {
  return (
    cell.environment !== AKASH_LANE_HOST_ENV &&
    cell.deploymentProvider === "akash" &&
    cell.computeApi === "crossplane"
  );
}

/**
 * The environment whose CLUSTER reconciles this cell. Identity for every k3s row, every legacy
 * akash row, and every production row; {@link AKASH_LANE_HOST_ENV} for a hosted lane.
 *
 * This is the north star's "explicit reviewed `writerFor(env) → cluster` map", expressed as one
 * total function so no caller can invent a fourth answer.
 */
export function resolveLaneHostEnv(cell: AkashLaneCell): string {
  return isHostedAkashLane(cell) ? AKASH_LANE_HOST_ENV : cell.environment;
}

/**
 * The directory NAME under `infra/k8s/argocd/appsets/` that must hold this cell's
 * ApplicationSet file. The FILE NAME is unchanged in every case (`<env>-<node>-applicationset
 * .yaml`), and so is the file's CONTENT — only the containing directory, and therefore the
 * app-of-apps that applies it, differs. That is what makes "only the delivery target changed"
 * checkable by `diff` rather than by argument.
 */
export function appsetsDirForLane(cell: AkashLaneCell): string {
  return isHostedAkashLane(cell) ? HOSTED_LANE_APPSETS_DIR : cell.environment;
}
