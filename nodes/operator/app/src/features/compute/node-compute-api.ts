// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/node-compute-api`
 * Purpose: Read one node's `compute_api.<env>` catalog cell and name the one refusal every old-path
 *   reader uses for it.
 * Scope: Pure catalog policy parsing. No workflow, git, provider, or cluster I/O.
 * Invariants:
 *   - ONE_WRITER_PER_NODE_LANE (CD4, story.5137): `node-deploy` is the ONLY cell value. It means
 *     "this (node, env) is deployed ONLY by the node-deploy sequencer (POST /api/v1/deploy/workloads)".
 *     The legacy ComputeWorkload controller and the Crossplane XComputeWorkload authority were
 *     deleted (task.5411, CD9), so the flight/promote path refuses or skips the cell with
 *     `NODE_ON_DEPLOY_VERB`.
 *   - AUTHORITY_IS_NOT_CALLER_INPUT: REST callers never select a deploy authority.
 * Side-effects: none
 * Links: story.5137, task.5411, infra/catalog/_schema.json
 * @internal
 */

import { z } from "zod";

import type { DeploymentEnvironment } from "./node-deployment-provider";

/**
 * The catalog cell value that hands one (node, env) to the node-deploy sequencer
 * (POST /api/v1/deploy/workloads). Mirrors `infra/catalog/_schema.json` `compute_api`.
 */
export const NODE_DEPLOY_COMPUTE_CELL = "node-deploy" as const;

/** Every value a `compute_api.<env>` catalog cell may hold. */
export const nodeComputeCellSchema = z.literal(NODE_DEPLOY_COMPUTE_CELL);
export type NodeComputeCell = z.infer<typeof nodeComputeCellSchema>;

/** Stable machine-readable refusal prefix, grep-able in flight and promote logs. */
export const NODE_ON_DEPLOY_VERB = "node_on_deploy_verb";

/** The one refusal sentence every old-path reader uses for a `node-deploy` cell. */
export function nodeOnDeployVerbMessage(
  node: string,
  environment: DeploymentEnvironment
): string {
  return `${NODE_ON_DEPLOY_VERB}: ${node} in ${environment} is deployed only by the node-deploy sequencer (catalog compute_api.${environment}=node-deploy) — use POST /api/v1/deploy/workloads. The flight/promote path never renders its workload, writes its deploy branch, or touches its lease or DNS (ONE_WRITER_PER_NODE_LANE).`;
}

const catalogComputeApiSchema = z
  .object({
    compute_api: z
      .object({
        "candidate-a": nodeComputeCellSchema.optional(),
        preview: nodeComputeCellSchema.optional(),
        production: nodeComputeCellSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

/** True when this (node, env) cell hands the lane to the node-deploy sequencer. */
export function isNodeOnDeployVerb(input: {
  readonly catalog: unknown;
  readonly environment: DeploymentEnvironment;
}): boolean {
  const parsed = catalogComputeApiSchema.safeParse(input.catalog);
  if (!parsed.success) {
    throw new Error(
      `[compute-api] Invalid catalog compute_api: ${parsed.error.message}`
    );
  }
  return (
    parsed.data.compute_api?.[input.environment] === NODE_DEPLOY_COMPUTE_CELL
  );
}

/** The only node the flight/promote lane still deploys: the operator control plane itself (k3s/Argo). */
export const OPERATOR_LANE_SLUG = "operator";

/** The body every flight/promote route returns (HTTP 409) for a non-operator node. */
export interface NodeOnDeployVerbRefusal {
  readonly error: typeof NODE_ON_DEPLOY_VERB;
  readonly errorCode: typeof NODE_ON_DEPLOY_VERB;
  readonly message: string;
  readonly deployVerb: "POST /api/v1/deploy/workloads";
}

/**
 * CD4 ONE_WRITER_PER_NODE_LANE at the REST front door (task.5411). Every node except the operator is
 * deployed only by the node-deploy sequencer, so the flight and promote routes refuse it BEFORE any
 * dispatch instead of letting a workflow skip it into a green no-op. Returns null for the operator.
 */
export function refuseNodeOnFlightPromoteLane(input: {
  readonly slug: string;
  readonly lane: "flight" | "promote";
  readonly environment: DeploymentEnvironment;
}): NodeOnDeployVerbRefusal | null {
  if (input.slug === OPERATOR_LANE_SLUG) return null;
  return {
    error: NODE_ON_DEPLOY_VERB,
    errorCode: NODE_ON_DEPLOY_VERB,
    message: `${input.lane} refused: ${nodeOnDeployVerbMessage(input.slug, input.environment)}`,
    deployVerb: "POST /api/v1/deploy/workloads",
  };
}
