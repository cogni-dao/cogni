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
  CANONICAL_DOMAIN_ROOT,
  type EnvPlanOp,
  externalSecretPath,
  overlayPath,
  schedulerEndpointPatchPath,
} from "./env-membership-plan";
import { renderNodeAppset, insertAppsetKustomization } from "./appset";
import { insertCaddyBlock } from "./caddyfile";
import { renderCatalog } from "./catalog";
import {
  NODE_DEPLOY_ENVS,
  NODE_FORMATION_ENVS,
  type NodeFormationEnv,
} from "./envs";
import { renderOverlay, renderOverlayFile } from "./overlay";
import {
  insertSchedulerEndpoint,
  updateSchedulerEndpointHost,
} from "./scheduler-endpoints";
import { nodeAppBaseUrl } from "../../node-registry/placement";

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

export interface BuildNodeBirthPlanInput {
  readonly slug: string;
  readonly nodeId: string;
  readonly sourceRepo: string;
  readonly sourceSha: string;
  readonly ownerWallet: string;
  readonly port: number;
  readonly nodePort: number;
  readonly repositoryUrl: string;
  readonly controlEnvFor: (env: NodeFormationEnv) => string;
  readonly current: {
    readonly templateOverlayByEnv: Readonly<Record<string, string>>;
    readonly templateExternalSecretByEnv: Readonly<Record<string, string>>;
    readonly appsetTemplate: string;
    readonly appsetsKustomizationByControlEnv: Readonly<Record<string, string>>;
    readonly caddyfile: string;
    readonly schedulerEndpointByPath: Readonly<Record<string, string>>;
  };
}

/**
 * Build the complete deterministic declarative node-registration tree. This is
 * the single content plan shared by the GitHub writer and the zero-install
 * verifier bundle; neither side may reconstruct these bytes independently.
 */
export function buildNodeBirthPlan(
  input: BuildNodeBirthPlanInput
): readonly EnvPlanOp[] {
  const catalog = renderCatalog(input.slug, input.port, input.nodePort, {
    sourceRepo: input.sourceRepo,
    nodeId: input.nodeId,
    sourceSha: input.sourceSha,
    ownerWallet: input.ownerWallet,
  });
  const ops: EnvPlanOp[] = [
    { op: "upsert", path: `infra/catalog/${input.slug}.yaml`, content: catalog },
  ];

  for (const env of NODE_FORMATION_ENVS) {
    const overlay = input.current.templateOverlayByEnv[env];
    const externalSecret = input.current.templateExternalSecretByEnv[env];
    if (overlay === undefined || externalSecret === undefined) {
      throw new Error(`node birth input missing template files for ${env}`);
    }
    ops.push(
      {
        op: "upsert",
        path: overlayPath(env, input.slug),
        content: renderOverlay(overlay, input.slug, input.nodePort, input.port),
      },
      {
        op: "upsert",
        path: externalSecretPath(env, input.slug),
        content: renderOverlayFile(
          externalSecret,
          input.slug,
          input.nodePort,
          input.port
        ),
      }
    );
  }

  const kustomizations = new Map<string, string>();
  for (const env of NODE_FORMATION_ENVS) {
    const controlEnv = input.controlEnvFor(env);
    ops.push({
      op: "upsert",
      path: appsetPath(controlEnv, env, input.slug),
      content: renderNodeAppset(
        input.current.appsetTemplate,
        input.slug,
        env,
        input.repositoryUrl
      ),
    });
    const current =
      kustomizations.get(controlEnv) ??
      input.current.appsetsKustomizationByControlEnv[controlEnv];
    if (current === undefined) {
      throw new Error(`node birth input missing appset index for ${controlEnv}`);
    }
    kustomizations.set(
      controlEnv,
      insertAppsetKustomization(current, input.slug, env)
    );
  }
  for (const [controlEnv, content] of kustomizations) {
    ops.push({
      op: "upsert",
      path: appsetsKustomizationPath(controlEnv),
      content,
    });
  }

  ops.push({
    op: "upsert",
    path: "infra/compose/edge/configs/Caddyfile.tmpl",
    content: insertCaddyBlock(
      input.current.caddyfile,
      input.slug,
      input.nodePort
    ),
  });

  const bornEnvs = new Set<string>(NODE_FORMATION_ENVS);
  for (const [path, current] of Object.entries(
    input.current.schedulerEndpointByPath
  )) {
    const spliced = insertSchedulerEndpoint(current, input.slug, input.nodeId);
    const patchEnv = path.match(
      /^infra\/k8s\/overlays\/([^/]+)\/scheduler-worker\/node-endpoints\.patch\.yaml$/
    )?.[1];
    ops.push({
      op: "upsert",
      path,
      content:
        patchEnv && bornEnvs.has(patchEnv)
          ? updateSchedulerEndpointHost(
              spliced,
              input.slug,
              input.nodeId,
              nodeAppBaseUrl({
                slug: input.slug,
                provider: "akash",
                environment: patchEnv as NodeFormationEnv,
                apexDomain: CANONICAL_DOMAIN_ROOT,
              })
            )
          : spliced,
    });
  }

  return ops;
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
