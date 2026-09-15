// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/crossplane-control-plane`
 * Purpose: CROSSPLANE_IS_INSTALLED_PER_ENVIRONMENT — the ONE enumeration of the deploy
 *   environments whose Argo control plane actually installs Crossplane (core chart, pinned
 *   packages, the `XComputeWorkload` XRD + Composition, and the credential-free
 *   ClusterProviderConfig). task.5097 widened it from `candidate-a` to every deploy environment.
 * Scope: A static fact about the deploy substrate, expressed as data. No I/O, no env read, no
 *   cluster contact — the fact is asserted against git by `tests/ci-invariants/
 *   crossplane-dormant-substrate.spec.ts`, which fails CI the moment this list and the
 *   installed reality disagree in either direction.
 * Invariants:
 *   - AUTHORITY_REQUIRES_AN_INSTALLED_API: naming `crossplane` for an environment that has no
 *     control plane renders an `XComputeWorkload` into a namespace where that CRD does not
 *     exist. The workload is then reconciled by NOBODY and the node never comes up.
 *   - NO_SILENT_DOWNGRADE: consumers must FAIL rather than degrade such a row to `legacy`. The
 *     two authorities mint Akash leases under deliberately disjoint idempotence keys
 *     (`<ns>:<name>:<uid>:<gen>:<op>:<ord>` vs `xcw:<ns>:<name>:<epoch>`), so a quiet fallback
 *     buys a SECOND PAID LEASE instead of colliding safely.
 *   - INSTALLED_IS_NOT_FUNDED: an installed control plane can RECONCILE a composite; only a
 *     pinned wallet can PAY for one. They are separate facts with separate constants, because
 *     widening the first without the second is exactly the inert staging task.5097 wanted and
 *     conflating them would have flipped every new node's birth row on merge.
 * Why shared, not `@features/compute`: both the catalog policy resolver (features) and the
 *   node-formation catalog generator (`@shared/node-app-scaffold/gens/catalog`) must agree on
 *   this set, and `shared` may not import `features` (.dependency-cruiser.cjs `not-in-allowed`).
 *   Same shape as `NODE_DEPLOYMENT_PROVIDERS` in `./placement`, for the same reason.
 * Side-effects: none (pure)
 * Links: infra/k8s/argocd/control-plane/{candidate-a,preview,production}/,
 *   infra/crossplane/xcomputeworkload/, infra/k8s/overlays/<env>/operator/kustomization.yaml,
 *   src/features/compute/node-compute-api.ts, tests/ci-invariants/crossplane-dormant-substrate.spec.ts,
 *   task.5096, task.5097, task.5104, story.5016
 * @public
 */

/**
 * Environments carrying a Crossplane control plane — i.e. where `XComputeWorkload` is an
 * INSTALLED API that something will reconcile.
 *
 * task.5094/task.5096 installed it on candidate-a alone (CANDIDATE_FIRST); task.5097 staged the
 * same three Applications for preview and production so the cutover is a catalog flip plus a
 * secret write rather than days of manifest work. Adding an environment here without also
 * committing its
 * `infra/k8s/argocd/control-plane/<env>/crossplane-xcomputeworkload-application.yaml`
 * turns CI red, and so does the reverse.
 *
 * WIDENING THIS LIST ACTIVATES NOTHING. It states where a composite COULD be reconciled, not
 * where one IS: the selector is the per-row `compute_api.<env>` cell in `infra/catalog/*.yaml`,
 * and `resolveNodeComputeApi` resolves an absent cell to `legacy` (LEGACY_IS_DEFAULT). Every
 * fleet row omits the cell, so every fleet row is untouched by this constant's value.
 */
export const CROSSPLANE_CONTROL_PLANE_ENVS = ["candidate-a", "production"] as const;

export type CrossplaneControlPlaneEnv =
  (typeof CROSSPLANE_CONTROL_PLANE_ENVS)[number];

/**
 * Environments whose Akash transaction actuator has a PINNED wallet — the second, independent
 * fact (INSTALLED_IS_NOT_FUNDED). An env is listed here iff its operator overlay pins a
 * non-empty `AKASH_ACTUATOR_ACCOUNT_ID` on the `akash-tx-actuator` Deployment, which is
 * asserted in both directions by `tests/ci-invariants/crossplane-dormant-substrate.spec.ts`.
 *
 * Why it is NOT the same list as {@link CROSSPLANE_CONTROL_PLANE_ENVS}: an installed control
 * plane can RECONCILE a composite, but only a funded, revocation-proven Console account can PAY
 * for the lease it asks for. task.5097 staged preview/production with `AKASH_ACTUATOR_ACCOUNT_ID`
 * deliberately `""` and their OpenBao buckets unseeded, so their actuators fail closed
 * (`actuator_account_id_missing`) and the legacy controller remains each env's ONE active writer
 * on the shared sponsor wallet — ONE_WALLET_ONE_ACTIVE_WRITER.
 *
 * This is the set a node BIRTH may mint `compute_api.<env>: crossplane` into: a birth row
 * pointed at an env with no wallet would render a composite whose every paid transaction is
 * refused, which is a broken node rather than a staged one. It is deliberately NOT the guard on
 * `resolveNodeComputeApi` — a human flipping an existing row is making an explicit cutover
 * decision, and that guard's question is only "does the CRD exist there".
 */
export const CROSSPLANE_ACTUATOR_WALLET_ENVS = ["candidate-a"] as const;

/**
 * The Argo Application that installs the `XComputeWorkload` composite API in `environment`.
 * Named in error messages so a failure states the exact file that has to exist.
 */
export function crossplaneCompositeApplicationPath(
  environment: string
): string {
  return `infra/k8s/argocd/control-plane/${environment}/crossplane-xcomputeworkload-application.yaml`;
}

/** Does `environment` have a Crossplane control plane to reconcile an `XComputeWorkload`? */
export function hasCrossplaneControlPlane(environment: string): boolean {
  return (CROSSPLANE_CONTROL_PLANE_ENVS as readonly string[]).includes(
    environment
  );
}

/**
 * May a NEWLY BORN node be minted onto the Crossplane authority in `environment`? Requires both
 * facts: an installed composite API to reconcile the workload, AND a pinned actuator wallet to
 * pay for its lease. Staging a control plane therefore does not change what a birth renders.
 */
export function canBirthOnCrossplane(environment: string): boolean {
  return (
    hasCrossplaneControlPlane(environment) &&
    (CROSSPLANE_ACTUATOR_WALLET_ENVS as readonly string[]).includes(environment)
  );
}
