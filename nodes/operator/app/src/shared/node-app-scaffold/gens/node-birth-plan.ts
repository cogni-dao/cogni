// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/node-birth-plan`
 * Purpose: Define the complete path contract for one operator-authored node-birth commit.
 * Scope: Pure path planning only; content renderers remain in their focused modules.
 * Invariants:
 *   - EXECUTABLE_OUTPUT_IS_INELIGIBLE: the origin/main writer's compiled runtime-source mutation is
 *     excluded from the replayable target.
 *   - DECLARATIVE_SHARED_CONFIG_IS_REPLAYABLE: a shared file is safe when a trusted-main renderer
 *     can reproduce its exact bytes; shared does not imply executable or unsafe.
 *   - ONE_TARGET_SEAM: writer and classifier work must converge on this exact declarative footprint
 *     rather than growing separate path allowlists.
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
  /** What the writer emitted before executable roster isolation: 13 declarative paths + source. */
  readonly current: readonly string[];
  /** Declarative footprint whose exact bytes can be replayed from trusted main. */
  readonly replayableDeclarative: readonly string[];
  /** Fail-closed classifier contract. Empty until writer and verifier changes land together. */
  readonly eligible: readonly string[];
  readonly blockers: readonly string[];
}

/**
 * Inventory the pre-isolation 14-path footprint and its 13-path declarative replay target. The
 * catalog, node leaves, per-lane ApplicationSets, shared AppSet index, Caddy route table, and
 * scheduler route tables are all deterministic configuration. The compiled TypeScript roster is
 * executable source and is the sole excluded path.
 *
 * `eligible` stays empty until the writer omission and trusted-main replay verifier land together.
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
  const nodeOwned = [catalog, ...overlays, ...appsets];
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
  const replayableDeclarative = [
    ...nodeOwned,
    ...sharedAppsetIndexes,
    "infra/compose/edge/configs/Caddyfile.tmpl",
    ...schedulerProjections,
  ].sort();
  const current = [
    ...replayableDeclarative,
    "nodes/operator/app/src/adapters/server/node-registry/network-nodes.data.ts",
  ].sort();

  return {
    current,
    replayableDeclarative,
    eligible: [],
    blockers: [
      "compiled network-nodes.data.ts runtime source is excluded from node birth",
    ],
  };
}
