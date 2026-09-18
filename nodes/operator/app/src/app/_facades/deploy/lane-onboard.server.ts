// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/lane-onboard.server`
 * Purpose: Env-membership merge → lane reconcile. The `POST /nodes/{id}/envs` verb opens a
 *   catalog PR and returns; until now NOTHING acted on the merge, so the verb was only ever
 *   half an operation. A lane's ApplicationSet serves its desired state from
 *   `deploy/<lane>-<slug>`, and its substrate belongs to the cluster that CUSTODIES the lane —
 *   neither of which the catalog edit on `main` touches. So an added lane came up with the
 *   PREVIOUS render (for Akash, a spent `leaseGeneration` → `identity_conflict`) against a
 *   database that was never created. This closes the verb: on merge, dispatch the reconcile
 *   the lane actually needs.
 * Scope: Webhook-triggered facade, sibling of `node-preview-promote.server`. Matches the verb's
 *   own branch, reads the merged catalog, and delegates to EXISTING deploy-plane dispatchers.
 *   It owns no promotion semantics of its own and creates no new render path.
 * Invariants:
 *   - VERB_BRANCH_ONLY: acts only on a merged PR whose head ref is the verb's own
 *     `cogni-operator/node-env-<slug>-<env>` (github-repo-write.ts `nodeEnvBranch`) on the
 *     parent monorepo. Every other merge — the overwhelming majority — is a no-op.
 *   - CATALOG_AFTER_MERGE_DECIDES: ADD vs REMOVE is read from the MERGED catalog `envs:`, never
 *     inferred from the branch name (both actions use the same branch). A remove dispatches
 *     nothing: Argo's keystone prunes the lane, and rendering a lane that just left would
 *     resurrect it.
 *   - SUBSTRATE_FOLLOWS_THE_CUSTODIAN: when `controlEnvFor(lane) !== lane` the lane's database,
 *     roles and Temporal namespace live in the custodian's cluster, and only a run that IS that
 *     env holds the identities to create them (`run-node-substrate.sh` loops every lane its env
 *     custodies). So the custodian's own promote is dispatched — this facade never hands a lane's
 *     run the custodian's credentials, which is the down-trust inversion bug.5206 rejects.
 *   - NAME_AND_PATH_FOLLOW_THE_LANE: the render is dispatched for the LANE — candidate-a through
 *     the flight lever, preview/production through the promote lever. One existing dispatcher
 *     each; no fourth trigger (spec.node-ci-cd-contract § Lane vs control env).
 *   - ONE_EVENT: exactly one terminal `feature.lane_onboard.complete`, including the no-dispatch
 *     outcomes. A pre-prod lane add CAN dispatch a production promote — that must never be a
 *     mystery deploy, so it is findable in Loki by event name.
 * Side-effects: IO (GitHub REST via DeployPlanePort). Fire-and-forget; never throws into the
 *   webhook, which 200s regardless.
 * Links: docs/spec/node-ci-cd-contract.md § Lane vs control env, task.5132,
 *   src/ports/deploy-plane.port.ts, src/app/api/v1/nodes/[id]/envs/route.ts
 * @public
 */

import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import type { ServerEnv } from "@/shared/env";
import { controlEnvFor } from "@/shared/node-registry/placement";
import { EVENT_NAMES } from "@/shared/observability";

/** The verb's branch: `cogni-operator/node-env-<slug>-<env>` (github-repo-write.ts). */
const VERB_BRANCH =
  /^cogni-operator\/node-env-(.+)-(candidate-a|preview|production)$/;

type Lane = "candidate-a" | "preview" | "production";

interface LaneOnboardContext {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly slug: string;
  readonly lane: Lane;
}

/**
 * Narrow a `pull_request` webhook payload to a merged env-membership PR, or null.
 *
 * The slug is greedy up to the env suffix because a slug may itself contain `-`
 * (`node-template-candidate-a` → slug `node-template`, lane `candidate-a`); the lane alternation
 * is a closed set, so the split is unambiguous.
 */
function extractLaneOnboard(
  payload: Record<string, unknown>,
  env: ServerEnv
): LaneOnboardContext | null {
  if (payload.action !== "closed") return null;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!pr || !repo || pr.merged !== true) return null;

  const repoOwner = (repo.owner as Record<string, unknown> | undefined)?.login;
  const repoName = repo.name;
  const prNumber = pr.number;
  const headRef = (pr.head as Record<string, unknown> | undefined)?.ref;
  if (
    typeof repoOwner !== "string" ||
    typeof repoName !== "string" ||
    typeof prNumber !== "number" ||
    typeof headRef !== "string"
  ) {
    return null;
  }

  // The verb only ever opens its PR on the parent monorepo (CATALOG_IS_SSOT). A same-named
  // branch on a node's own repo is not this operation.
  if (
    repoOwner !== env.NODE_SUBMODULE_PARENT_OWNER ||
    repoName !== env.NODE_SUBMODULE_PARENT_REPO
  ) {
    return null;
  }

  const match = VERB_BRANCH.exec(headRef);
  if (!match?.[1] || !match[2]) return null;

  return {
    owner: repoOwner,
    repo: repoName,
    prNumber,
    slug: match[1],
    lane: match[2] as Lane,
  };
}

/** The two catalog cells this facade reads; everything else in the row is irrelevant here. */
interface CatalogRow {
  readonly envs?: readonly string[];
  readonly node_id?: string;
  readonly source_sha?: string;
  readonly deployment_provider?: Readonly<Record<string, string>>;
}

export function dispatchLaneOnboard(
  payload: Record<string, unknown>,
  env: ServerEnv,
  log: Logger
): void {
  const ctx = extractLaneOnboard(payload, env);
  if (!ctx) return;

  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    log.debug(
      "lane onboard skipped — GH_REVIEW_APP_ID/PRIVATE_KEY not configured"
    );
    return;
  }

  void onboardLane(ctx, env, log);
}

async function onboardLane(
  ctx: LaneOnboardContext,
  env: ServerEnv,
  log: Logger
): Promise<void> {
  // No reqId: this is a fire-and-forget webhook dispatch, not a request-scoped handler, and the
  // event name is operator-local (not in @cogni/node-shared's `EventName`) — so it is logged the
  // same way its siblings NODE_PREVIEW_PROMOTE_COMPLETE and NODE_ACCESS_REQUEST_COMPLETE are,
  // rather than through logEvent(), which requires both.
  const base = {
    event: EVENT_NAMES.LANE_ONBOARD_COMPLETE,
    slug: ctx.slug,
    env: ctx.lane,
    prNumber: ctx.prNumber,
  };

  try {
    const deployPlane = createOperatorDeployPlane(env);
    const catalogText = await deployPlane.fetchFileText({
      owner: ctx.owner,
      repo: ctx.repo,
      path: `infra/catalog/${ctx.slug}.yaml`,
      ref: "main",
    });
    if (!catalogText) {
      log.info(
        {
          ...base,
          dispatched: 0,
          outcome: "skipped",
          errorCode: "catalog_absent",
        },
        EVENT_NAMES.LANE_ONBOARD_COMPLETE
      );
      return;
    }

    const row = parseYaml(catalogText) as CatalogRow;
    // CATALOG_AFTER_MERGE_DECIDES — a REMOVE leaves the lane out of `envs:`; Argo's keystone
    // prunes it and there is nothing to reconcile.
    if (!row.envs?.includes(ctx.lane)) {
      log.info(
        { ...base, dispatched: 0, outcome: "removed" },
        EVENT_NAMES.LANE_ONBOARD_COMPLETE
      );
      return;
    }

    const provider =
      row.deployment_provider?.[ctx.lane] === "akash" ? "akash" : "k3s";
    const controlEnv = controlEnvFor(ctx.lane, provider);
    // The node's own commit for a remote-source row; the operator ref for an in-repo one. The
    // catalog pin IS the deploy identity (CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN) — this facade
    // renders what the catalog states, never a sha of its own choosing.
    const sourceSha = row.source_sha;

    let dispatched = 0;

    // SUBSTRATE_FOLLOWS_THE_CUSTODIAN — dispatch the custodian's own run first so its
    // `run-node-substrate.sh <controlEnv> <slug>` lane loop creates this lane's database,
    // roles and Temporal namespace under the identities that own them.
    if (controlEnv !== ctx.lane && sourceSha) {
      await deployPlane.promoteNode({
        env: controlEnv as "preview" | "production",
        parentOwner: ctx.owner,
        parentRepo: ctx.repo,
        slug: ctx.slug,
        sourceSha,
      });
      dispatched += 1;
    }

    // NAME_AND_PATH_FOLLOW_THE_LANE — render the lane's own desired state. candidate-a renders
    // through the flight lever (the same prepare→dispatch pair POST /vcs/flight uses, so the
    // GHCR preflight is not re-derived here); preview and production through the promote lever.
    if (ctx.lane === "candidate-a" && row.node_id && sourceSha) {
      const prepared = await deployPlane.prepareNodeRefCandidateFlight({
        parentOwner: ctx.owner,
        parentRepo: ctx.repo,
        nodeId: row.node_id,
        slug: ctx.slug,
        sourceSha,
      });
      await deployPlane.dispatchNodeRefCandidateFlight({
        owner: ctx.owner,
        repo: ctx.repo,
        slug: prepared.slug,
        sourceSha: prepared.sourceSha,
      });
      dispatched += 1;
    } else if (ctx.lane !== "candidate-a" && sourceSha) {
      await deployPlane.promoteNode({
        env: ctx.lane,
        parentOwner: ctx.owner,
        parentRepo: ctx.repo,
        slug: ctx.slug,
        sourceSha,
      });
      dispatched += 1;
    }

    log.info(
      {
        ...base,
        controlEnv,
        dispatched,
        outcome: dispatched > 0 ? "dispatched" : "skipped",
      },
      EVENT_NAMES.LANE_ONBOARD_COMPLETE
    );
  } catch (error) {
    log.error(
      {
        ...base,
        dispatched: 0,
        outcome: "error",
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "lane_onboard_failed",
      },
      EVENT_NAMES.LANE_ONBOARD_COMPLETE
    );
  }
}
