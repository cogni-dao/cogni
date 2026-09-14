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
 * Side-effects: none
 * Links: task.5097, story.5016, infra/catalog/_schema.json, infra/crossplane/xcomputeworkload/
 * @internal
 */

import { z } from "zod";

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
  return parsed.data.compute_api?.[input.environment] ?? "legacy";
}
