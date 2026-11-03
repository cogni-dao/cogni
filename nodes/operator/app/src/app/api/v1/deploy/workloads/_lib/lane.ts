// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/_lib/lane`
 * Purpose: The lane refusals of the node-deploy verb, decided from the node's image-baked catalog row:
 *   does THIS operator serve the requested env for THIS node (`envNotServed`), and is the node's cell
 *   actually handed to the verb (`nodeNotOnDeployVerb`). One front door, every env (story.5137).
 * Scope: Pure decisions over `(env, nodeId, catalogRow)`; reads only `serverEnv()` and the operator node id.
 * Invariants:
 *   - SERVED_ENV_SET (CD4 a): `env` must be one of the envs this deployment's sequencer serves
 *     (`NODE_DEPLOY_ENVS`, default: only DEPLOY_ENVIRONMENT). A release for any other env would never be
 *     executed here (or, worse, by a differently-wired sequencer).
 *   - NODE_IS_THIS_FLEETS (CD4 b): a node other than the operator's own canary must belong to this fleet
 *     (`isFleetOwnedRow`: its `source_repo` org equals NODE_SUBMODULE_PARENT_OWNER, case-insensitive) AND
 *     its lane's control env (`controlEnvFor(env, provider, FLEET_CONTROL_ENV)`) must be the fleet control
 *     env. The test operator therefore refuses canonical toks5 even though the canonical catalog is baked
 *     into its image. The sequencer applies the same org filter to its slug set.
 *   - ONE_WRITER_PER_NODE_LANE (CD4 c): a release is recorded only when the node's catalog
 *     `compute_api[env]` is `node-deploy` (image-baked catalog, the source the sequencer reads), so the verb
 *     never races a Crossplane/legacy writer.
 *   - OPERATOR_CANARY_UNCHANGED: the operator node (in-repo) is served only in DEPLOY_ENVIRONMENT, as before,
 *     and is exempt from the fleet and cell checks.
 *   - VERB_CELL_IS_AKASH: a `compute_api[env]=node-deploy` cell is by definition Akash-placed, whatever
 *     `deployment_provider` says, so it resolves its control env as an Akash lane. Reuses `controlEnvFor`
 *     (the TS twin of `control_env_for` in scripts/ci/lib/appset-paths.sh).
 * Side-effects: none
 * Links: features/compute/node-compute-api.ts (isNodeOnDeployVerb), shared/node-registry/placement.ts
 *   (controlEnvFor), shared/node-registry/fleet-ownership.ts, hub `operator-cd-axioms`
 * @internal
 */

import { NextResponse } from "next/server";
import { isNodeOnDeployVerb } from "@/features/compute/node-compute-api";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { isFleetOwnedRow } from "@/shared/node-registry/fleet-ownership";
import {
  controlEnvFor,
  providerForEnv,
  toNodeDeploymentPlacement,
} from "@/shared/node-registry/placement";

type Env = "candidate-a" | "preview" | "production";

/** `false` for an unreadable row: a catalog row we cannot parse never hands a lane to the verb. */
function onDeployVerb(catalogRow: unknown, env: Env): boolean {
  if (catalogRow === undefined) return false;
  try {
    return isNodeOnDeployVerb({ catalog: catalogRow, environment: env });
  } catch {
    return false;
  }
}

/** The envs this deployment's sequencer serves. */
export function servedEnvs(config: {
  DEPLOY_ENVIRONMENT?: string | undefined;
  NODE_DEPLOY_ENVS?: string | undefined;
}): string[] {
  const listed = (config.NODE_DEPLOY_ENVS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (listed.length > 0) return listed;
  return config.DEPLOY_ENVIRONMENT ? [config.DEPLOY_ENVIRONMENT] : [];
}

/** The env whose control plane reconciles this node's `env` lane. */
export function laneControlEnv(
  catalogRow: unknown,
  env: Env,
  fleetControlEnv: string | undefined
): string {
  const placement =
    typeof catalogRow === "object" && catalogRow !== null
      ? toNodeDeploymentPlacement(
          (catalogRow as { deployment_provider?: unknown }).deployment_provider
        )
      : {};
  const provider = onDeployVerb(catalogRow, env)
    ? "akash"
    : providerForEnv(placement, env);
  return controlEnvFor(env, provider, fleetControlEnv);
}

export interface LaneRefusal {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** The config `laneRefusal` reads; `serverEnv()` satisfies it, and so does a webhook's `ServerEnv`. */
export interface LaneConfig {
  DEPLOY_ENVIRONMENT?: string | undefined;
  NODE_DEPLOY_ENVS?: string | undefined;
  NODE_SUBMODULE_PARENT_OWNER?: string | undefined;
  FLEET_CONTROL_ENV?: string | undefined;
}

/**
 * CD4 (a)+(b) as a RESULT, shared by every caller of the release writer (the verb route and the merge
 * webhook): refuse a lane this deployment does not serve or a node this fleet does not own.
 * `reason` is the stable machine name. 503 when the deployment has no served env at all.
 */
export function laneRefusal(
  env: Env,
  nodeId: string,
  catalogRow: unknown,
  config: LaneConfig = serverEnv()
): (LaneRefusal & { readonly reason: string }) | undefined {
  const served = servedEnvs(config);
  const refuse = (
    status: number,
    body: Record<string, unknown>
  ): LaneRefusal & { readonly reason: string } => ({
    status,
    body,
    reason: String(body.error),
  });
  if (served.length === 0)
    return refuse(503, { error: "deploy_environment_not_configured" });
  if (nodeId === getNodeId()) {
    // OPERATOR_CANARY_UNCHANGED: only its own env.
    if (env !== config.DEPLOY_ENVIRONMENT)
      return refuse(409, {
        error: "env_not_served",
        served: [config.DEPLOY_ENVIRONMENT],
      });
    return undefined;
  }
  if (!served.includes(env))
    return refuse(409, { error: "env_not_served", served });
  if (!isFleetOwnedRow(catalogRow, config.NODE_SUBMODULE_PARENT_OWNER))
    return refuse(409, { error: "node_not_in_fleet" });
  const fleetControlEnv = config.FLEET_CONTROL_ENV?.trim() || "production";
  const controlEnv = laneControlEnv(catalogRow, env, fleetControlEnv);
  if (controlEnv !== fleetControlEnv)
    return refuse(409, { error: "env_not_served", served, controlEnv });
  return undefined;
}

/** HTTP form of `laneRefusal` for the verb route. */
export function envNotServed(
  env: Env,
  nodeId: string,
  catalogRow: unknown
): NextResponse | undefined {
  const refusal = laneRefusal(env, nodeId, catalogRow);
  return refusal
    ? NextResponse.json(refusal.body, { status: refusal.status })
    : undefined;
}

/**
 * CD4 (c) ONE_WRITER_PER_NODE_LANE: refuse to record unless the node's cell hands this lane to the verb.
 * The operator's own canary (in-repo, no `compute_api` row) is exempt.
 */
export function nodeNotOnDeployVerb(
  env: Env,
  nodeId: string,
  catalogRow: unknown
): NextResponse | undefined {
  if (nodeId === getNodeId()) return undefined;
  if (onDeployVerb(catalogRow, env)) return undefined;
  return NextResponse.json(
    {
      error: "node_not_on_deploy_verb",
      message: `this node's ${env} lane is not handed to the node-deploy verb (catalog compute_api.${env} must be node-deploy)`,
    },
    { status: 409 }
  );
}
