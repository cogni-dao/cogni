// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/node-compute-api`
 * Purpose: Resolve WHICH reconciliation authority owns one node's workload in one environment.
 * Scope: Pure catalog policy parsing. No workflow, git, provider, or cluster I/O.
 * Invariants:
 *   - LEGACY_IS_DEFAULT: an absent env override preserves the bespoke ComputeWorkload controller,
 *     so adding this field changes nothing until a row opts in. Mirrors K3S_IS_DEFAULT exactly.
 *   - ONE_AUTHORITY_PER_WORKLOAD: this cell is the ONLY selector, and it is single-valued, so a
 *     (node, environment) pair can never name two authorities. The materializer renders the kind
 *     this resolves to and nothing else; see `computeWorkloadManifestFile`.
 *   - AUTHORITY_IS_NOT_CALLER_INPUT: REST callers never select a reconciler.
 *   - AUTHORITY_REQUIRES_AN_INSTALLED_API: `crossplane` is only resolvable in an environment
 *     that actually carries a Crossplane control plane (CROSSPLANE_CONTROL_PLANE_ENVS). A row
 *     naming it elsewhere THROWS — it never degrades to `legacy`.
 * Side-effects: none
 * Links: task.5097, story.5016, infra/catalog/_schema.json, infra/crossplane/xcomputeworkload/
 * @internal
 */

import { z } from "zod";

import {
  CROSSPLANE_CONTROL_PLANE_ENVS,
  crossplaneCompositeApplicationPath,
  hasCrossplaneControlPlane,
} from "@/shared/node-registry/crossplane-control-plane";

import type { DeploymentEnvironment } from "./node-deployment-provider";

/**
 * The two reconciliation authorities that can own an akash-placed workload.
 *
 * `legacy` — the bespoke in-cluster `compute-workload-controller` reconciling
 *   `computeworkloads.compute.cogni.io`. Retired by task.5098.
 * `crossplane` — `xcomputeworkloads.compute.cogni.io`, reconciled by Crossplane
 *   through the pinned provider-http Composition (task.5096).
 *
 * They are DISJOINT Kubernetes kinds, so they cannot contend over the same API object.
 * They DO contend over the same scarce external resource — the paid Akash lease — because
 * each mints its own under its own idempotence key (`<ns>:<name>:<uid>:<gen>:<op>:<ord>` for
 * legacy, `xcw:<ns>:<name>` for Crossplane). Those keys are deliberately disjoint, which means
 * a workload rendered as BOTH kinds would buy TWO leases rather than collide safely. That is
 * why the exactly-one-kind render is the fence, and why it is asserted in code rather than
 * left to reviewer discipline.
 */
export const NODE_COMPUTE_APIS = ["legacy", "crossplane"] as const;

/**
 * The environments that can legally resolve to `crossplane`, re-exported here so the compute
 * feature has one import site for the whole authority vocabulary. It is DEFINED in `shared`
 * because the node-formation catalog generator must filter on the same set and `shared` may not
 * import `features`. `tests/ci-invariants/crossplane-dormant-substrate.spec.ts` pins it to the
 * control-plane directories that actually install the composite API.
 */
export { CROSSPLANE_CONTROL_PLANE_ENVS };

export const nodeComputeApiSchema = z.enum(NODE_COMPUTE_APIS);
export type NodeComputeApi = z.infer<typeof nodeComputeApiSchema>;

const catalogComputeApiSchema = z
  .object({
    compute_api: z
      .object({
        "candidate-a": nodeComputeApiSchema.optional(),
        preview: nodeComputeApiSchema.optional(),
        production: nodeComputeApiSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

/**
 * Resolve one env's compute authority. Missing policy is deliberately the pre-existing
 * bespoke controller, so this field is inert for every row that has not opted in.
 *
 * AUTHORITY_REQUIRES_AN_INSTALLED_API. A row that names `crossplane` for an environment with no
 * Crossplane control plane is a MISCONFIGURATION, not a fallback case: the materializer would
 * render an `XComputeWorkload` into a cluster where that CRD does not exist, so nothing
 * reconciles it. This throws instead of degrading to `legacy`, because the two authorities mint
 * Akash leases under disjoint idempotence keys — a silent downgrade buys a second paid lease
 * rather than colliding safely (see the module header).
 */
export function resolveNodeComputeApi(input: {
  readonly catalog: unknown;
  readonly environment: DeploymentEnvironment;
}): NodeComputeApi {
  const parsed = catalogComputeApiSchema.safeParse(input.catalog);
  if (!parsed.success) {
    throw new Error(
      `[compute-api] Invalid catalog compute_api: ${parsed.error.message}`
    );
  }
  const resolved = parsed.data.compute_api?.[input.environment] ?? "legacy";
  if (
    resolved === "crossplane" &&
    !hasCrossplaneControlPlane(input.environment)
  ) {
    throw new Error(
      `[compute-api] compute_api.${input.environment}=crossplane, but '${input.environment}' has no Crossplane control plane — ${crossplaneCompositeApplicationPath(input.environment)} does not exist, so XComputeWorkload is not an installed API there. Install the control plane for '${input.environment}' (mirror infra/k8s/argocd/control-plane/candidate-a/crossplane-*-application.yaml) and add it to CROSSPLANE_CONTROL_PLANE_ENVS, currently [${CROSSPLANE_CONTROL_PLANE_ENVS.join(", ")}]. Refusing to fall back to 'legacy': the two authorities mint Akash leases under disjoint idempotence keys, so a silent downgrade buys a SECOND PAID LEASE.`
    );
  }
  return resolved;
}
