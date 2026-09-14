// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/crossplane-control-plane`
 * Purpose: CROSSPLANE_IS_INSTALLED_PER_ENVIRONMENT — the ONE enumeration of the deploy
 *   environments whose Argo control plane actually installs Crossplane (core chart, pinned
 *   packages, the `XComputeWorkload` XRD + Composition, and the credential-free
 *   ClusterProviderConfig). Today that is `candidate-a` and only `candidate-a`.
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
 * Why shared, not `@features/compute`: both the catalog policy resolver (features) and the
 *   node-formation catalog generator (`@shared/node-app-scaffold/gens/catalog`) must agree on
 *   this set, and `shared` may not import `features` (.dependency-cruiser.cjs `not-in-allowed`).
 *   Same shape as `NODE_DEPLOYMENT_PROVIDERS` in `./placement`, for the same reason.
 * Side-effects: none (pure)
 * Links: infra/k8s/argocd/control-plane/candidate-a/, infra/crossplane/xcomputeworkload/,
 *   src/features/compute/node-compute-api.ts, tests/ci-invariants/crossplane-dormant-substrate.spec.ts,
 *   task.5096, task.5104, story.5016
 * @public
 */

/**
 * Environments carrying a Crossplane control plane. CANDIDATE_FIRST (task.5094/task.5096): the
 * engine was installed on the transient proof slot first and has not been promoted. Adding an
 * environment here without also committing its
 * `infra/k8s/argocd/control-plane/<env>/crossplane-xcomputeworkload-application.yaml`
 * turns CI red, and so does the reverse.
 */
export const CROSSPLANE_CONTROL_PLANE_ENVS = ["candidate-a"] as const;

export type CrossplaneControlPlaneEnv =
  (typeof CROSSPLANE_CONTROL_PLANE_ENVS)[number];

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
