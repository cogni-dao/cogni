// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/node-birth-plan`
 * Purpose: Define the complete path contract for one operator-authored node-birth commit.
 * Scope: Pure path planning only; content renderers remain in their focused modules.
 * Invariants:
 *   - CURRENT_IS_NOT_ELIGIBLE: today's writer still mutates shared projections, so no path is
 *     exposed as fast-path eligible.
 *   - ISOLATED_TARGET_IS_NODE_SCOPED: the target contains only the node's catalog row, overlay
 *     leaves, and per-lane ApplicationSets. Naming the target does not claim its consumers exist.
 *   - ONE_TARGET_SEAM: future writer and classifier work must converge on this exact target rather
 *     than growing separate path allowlists.
 * Side-effects: none.
 * Links: story.5065, task.5184, docs/spec/node-formation.md
 * @public
 */

import {
  appsetPath,
  appsetsKustomizationPath,
  externalSecretPath,
  overlayPath,
  schedulerEndpointPatchPath,
} from "./env-membership-plan";
import {
  NODE_DEPLOY_ENVS,
  NODE_FORMATION_ENVS,
  type NodeFormationEnv,
} from "./envs";

export interface NodeBirthPathPlanInput {
  readonly slug: string;
  readonly controlEnvFor: (env: NodeFormationEnv) => string;
}

export interface NodeBirthPathPlan {
  /** What the writer emits today. Contains shared mutable projections, so it is never fast-path safe. */
  readonly current: readonly string[];
  /** The intended isolated footprint once every listed consumer has been replaced. */
  readonly isolatedTarget: readonly string[];
  /** Fail-closed classifier contract. Empty until the projection blockers are implemented and proven. */
  readonly eligible: readonly string[];
  readonly blockers: readonly string[];
}

/**
 * Inventory today's birth footprint and the immutable seven-path target:
 *
 * - one canonical catalog row;
 * - two node-owned overlay leaves per birth environment;
 * - one node-owned ApplicationSet per birth environment.
 *
 * Shared projections are absent from `isolatedTarget`, but their consumers have not all been replaced.
 * `eligible` therefore stays empty. This is deliberate: a classifier must not infer fast-path safety
 * merely because the desired footprint has been named.
 */
export function nodeBirthPathPlan(
  input: NodeBirthPathPlanInput
): NodeBirthPathPlan {
  const catalog = `infra/catalog/${input.slug}.yaml`;
  const overlays = NODE_FORMATION_ENVS.flatMap((env) => [
    overlayPath(env, input.slug),
    externalSecretPath(env, input.slug),
  ]);
  const appsets = NODE_FORMATION_ENVS.map((env) =>
    appsetPath(input.controlEnvFor(env), env, input.slug)
  );
  const isolatedTarget = [catalog, ...overlays, ...appsets].sort();
  const controlEnvs = new Set(
    NODE_FORMATION_ENVS.map((env) => input.controlEnvFor(env))
  );
  const sharedAppsetIndexes = [...controlEnvs].map((env) =>
    appsetsKustomizationPath(env)
  );
  const schedulerProjections = [
    "infra/k8s/base/scheduler-worker/configmap.yaml",
    ...NODE_DEPLOY_ENVS.map(schedulerEndpointPatchPath),
  ];
  const current = [
    ...isolatedTarget,
    ...sharedAppsetIndexes,
    "infra/compose/edge/configs/Caddyfile.tmpl",
    ...schedulerProjections,
    "nodes/operator/app/src/adapters/server/node-registry/network-nodes.data.ts",
  ].sort();

  return {
    current,
    isolatedTarget,
    eligible: [],
    blockers: [
      "appset directories still depend on a shared kustomization index",
      "edge drift checks still require the committed Caddy projection",
      "scheduler deployment still copies committed aggregate routing maps",
      "public discovery still compiles network-nodes.data.ts into the operator image",
    ],
  };
}
