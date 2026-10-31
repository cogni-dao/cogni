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
 * Scope: Verified-webhook facade, sibling of `node-preview-promote.server`. Binds signed operation
 *   history to the event's repository/PR/head/merge and delegates to EXISTING deploy-plane dispatchers.
 *   It owns no promotion semantics of its own and creates no new render path.
 * Invariants:
 *   - VERB_BRANCH_ONLY: acts only on a merged PR whose head ref is the verb's own
 *     `cogni-operator/node-env-<slug>-<env>` (github-repo-write.ts `nodeEnvBranch`) on the
 *     parent monorepo. Every other merge — the overwhelming majority — is a no-op.
 *   - VERIFIED_OPERATION: closed/merged classification is separate from open-PR authorization.
 *     Signed-head-parent and actual merge-parent deltas bind repair/add/remove identity.
 *   - CATALOG_AFTER_MERGE_DECIDES: signed action must agree with immutable merged membership.
 *     A remove dispatches the
 *     narrow prune workflow against the lane's control cluster; it never renders/promotes the
 *     lane that just left (which would resurrect it).
 *   - SUBSTRATE_FOLLOWS_THE_CUSTODIAN: when `controlEnvFor(lane) !== lane` the lane's database,
 *     roles and Temporal namespace live in the custodian's cluster, and only a run that IS that
 *     env holds the identities to create them (`run-node-substrate.sh` loops every lane its env
 *     custodies). So the custodian's own promote is dispatched — this facade never hands a lane's
 *     run the custodian's credentials, which is the down-trust inversion bug.5206 rejects.
 *   - REPLAY_NEVER_ADVANCES (bug.5237): every dispatch here renders an env AT THE SHA THAT ENV IS
 *     ALREADY RUNNING — `readNodeDeployPin(env)`, the pin promote/flight wrote on
 *     `deploy/<env>-<slug>`. The catalog `source_sha` is BIRTH-ONLY metadata and is used only when
 *     a verified first add has a proven missing own pin, as `promoteNode` has documented (bug.5043 retired it
 *     as a deploy authority). Reading it otherwise made a lane add on ANY env silently revert
 *     PRODUCTION to its birth sha: adding toks5 to candidate-a on 2026-09-23 re-promoted
 *     toks5.cognidao.org from the proven d6bc40d1 back to 7c9b1e08, twice. Substrate still gets
 *     created; the app never moves. Advancing an app stays the deploy verb's job, behind its
 *     own human gate — the same line `node-preview-promote.server` refuses to cross.
 *   - BOTH_PINS_BEFORE_EFFECTS: repair never falls back to birth; missing/invalid/unreadable
 *     own pins refuse with zero prepare/flight/promote calls. Later failures retain completed count.
 *   - NAME_AND_PATH_FOLLOW_THE_LANE: the render is dispatched for the LANE — candidate-a through
 *     the flight lever, preview/production through the promote lever. One existing dispatcher
 *     each; no fourth trigger (spec.node-ci-cd-contract § Lane vs control env).
 *   - ONE_EVENT: exactly one terminal `feature.lane_onboard.complete`, including the no-dispatch
 *     outcomes. A pre-prod lane add CAN dispatch a production render — a replay, never an
 *     advance — and that must never be a mystery deploy, so it is findable in Loki by event name
 *     and carries the sha each dispatch rendered.
 * Side-effects: IO (GitHub REST via DeployPlanePort). Fire-and-forget; never throws into the
 *   webhook, which 200s regardless.
 * Links: docs/spec/node-ci-cd-contract.md § Lane vs control env, task.5132,
 *   src/ports/deploy-plane.port.ts, src/app/api/v1/nodes/[id]/envs/route.ts
 * @public
 */

import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import type { DeployPlanePort } from "@/ports";
import type { ServerEnv } from "@/shared/env";
import {
  controlEnvFor,
  type NodeDeploymentProvider,
} from "@/shared/node-registry/placement";
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
  /**
   * The PR's base commit (`pull_request.base.sha`) — the PRE-MERGE catalog. A REMOVE reads the
   * removed lane's OWN `deployment_provider.<lane>` cell here, because the post-merge catalog on
   * `main` has already dropped that cell (see the REMOVE path). Null when the webhook omits it.
   */
  readonly baseSha: string | null;
  readonly headSha: string | null;
  readonly mergeSha: string | null;
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
  const baseSha = (pr.base as Record<string, unknown> | undefined)?.sha;
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
    repoOwner.toLowerCase() !==
      env.NODE_SUBMODULE_PARENT_OWNER?.toLowerCase() ||
    repoName.toLowerCase() !== env.NODE_SUBMODULE_PARENT_REPO?.toLowerCase()
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
    baseSha: typeof baseSha === "string" ? baseSha : null,
    headSha:
      typeof (pr.head as Record<string, unknown>)?.sha === "string"
        ? String((pr.head as Record<string, unknown>).sha)
        : null,
    mergeSha:
      typeof pr.merge_commit_sha === "string" ? pr.merge_commit_sha : null,
  };
}

/** The two catalog cells this facade reads; everything else in the row is irrelevant here. */
interface CatalogRow {
  readonly envs?: readonly string[];
  readonly node_id?: string;
  readonly source_sha?: string;
  readonly deployment_provider?: Readonly<Record<string, string>>;
}

/**
 * The REMOVED lane's OWN deployment provider, read from the PRE-MERGE catalog (`ctx.baseSha`).
 * The post-merge catalog has already dropped `deployment_provider.<lane>`, so it can no longer tell
 * whether the departing lane was akash — the fact that decides whether its paid lease must be pruned
 * from the fleet custodian. A cell-absent lane is k3s (K3S_IS_DEFAULT, symmetric with how ADD
 * records placement). If the base catalog cannot be read at all, default to `akash`: pruning a k3s
 * lane from the custodian is a harmless no-op, but treating an akash lane as k3s orphans a paid lease.
 */
async function removedLaneProvider(
  ctx: LaneOnboardContext,
  deployPlane: DeployPlanePort
): Promise<NodeDeploymentProvider> {
  if (!ctx.baseSha) return "akash";
  try {
    const preMergeText = await deployPlane.fetchFileText({
      owner: ctx.owner,
      repo: ctx.repo,
      path: `infra/catalog/${ctx.slug}.yaml`,
      ref: ctx.baseSha,
    });
    if (!preMergeText) return "akash";
    const preRow = parseYaml(preMergeText) as CatalogRow;
    return preRow.deployment_provider?.[ctx.lane] === "akash" ? "akash" : "k3s";
  } catch {
    return "akash";
  }
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
    repository: `${ctx.owner}/${ctx.repo}`,
    headSha: ctx.headSha,
    mergeSha: ctx.mergeSha,
  };
  let dispatched = 0;
  const completed: {
    env: string;
    sourceSha: string;
    runId?: number;
    workflowUrl?: string;
  }[] = [];

  try {
    const deployPlane = createOperatorDeployPlane(env);
    if (
      !ctx.headSha ||
      !ctx.mergeSha ||
      !/^[0-9a-f]{40}$/.test(ctx.headSha) ||
      !/^[0-9a-f]{40}$/.test(ctx.mergeSha)
    )
      throw Object.assign(new Error("Missing verified operation identity"), {
        code: "repair_context_unavailable",
      });
    const operation = await deployPlane.classifyEnvManagerPr({
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      mergedOperation: {
        repository: `${ctx.owner}/${ctx.repo}`,
        prNumber: ctx.prNumber,
        headSha: ctx.headSha,
        mergeSha: ctx.mergeSha,
      },
    });
    if (
      !operation.isEnvManagerPr ||
      operation.targetNodeRef !== ctx.slug ||
      operation.environment !== ctx.lane ||
      !operation.action ||
      !operation.headCatalog ||
      !operation.baseCatalog
    )
      throw Object.assign(new Error("Merged operation cannot be verified"), {
        code: operation.errorCode ?? "repair_context_conflict",
      });
    const catalogText = operation.headCatalog;
    const row = parseYaml(catalogText) as CatalogRow;
    // CATALOG_AFTER_MERGE_DECIDES — a REMOVE leaves the lane out of `envs:`. The generated
    // AppSet disappeared from git, but the live per-node AppSet is not guaranteed to be watched
    // by a main-tracking keystone (observed test-org #97: the paid lease remained orphaned).
    // Dispatch the one-object prune against the control cluster; never promote a retired lane.
    if (!row.envs?.includes(ctx.lane)) {
      if (operation.action !== "remove")
        throw Object.assign(new Error("Operation membership conflicts"), {
          code: "repair_context_conflict",
        });
      // CONTROL_ENV_FOLLOWS_THE_REMOVED_LANE (bug.5141 orphan-lease): resolve the control env from
      // the REMOVED lane's OWN provider, NOT from whatever providers survive in the post-merge
      // catalog. The merge dropped this lane's `deployment_provider.<lane>` cell, so scanning the
      // post-merge row mis-classifies the last akash lane as k3s → controlEnvFor returns the lane
      // itself → the prune SSHes to the wrong cluster and the paid Akash lease is orphaned. Read the
      // removed cell from the PRE-MERGE catalog (`base.sha`), exactly as the CI twin resolves a
      // REMOVE from the base catalog. If it cannot be read, default to `akash` so the prune targets
      // the custodian rather than silently leaking a lease.
      const provider = await removedLaneProvider(
        { ...ctx, baseSha: operation.parentSha ?? ctx.baseSha },
        deployPlane
      );
      const resolvedControlEnv = controlEnvFor(
        ctx.lane,
        provider,
        env.FLEET_CONTROL_ENV
      );
      if (
        resolvedControlEnv !== "candidate-a" &&
        resolvedControlEnv !== "preview" &&
        resolvedControlEnv !== "production"
      ) {
        throw Object.assign(
          new Error(`invalid fleet control environment: ${resolvedControlEnv}`),
          { code: "invalid_control_environment" }
        );
      }
      const controlEnv: Lane = resolvedControlEnv;
      const result = await deployPlane.pruneNodeEnvironment({
        parentOwner: ctx.owner,
        parentRepo: ctx.repo,
        slug: ctx.slug,
        env: ctx.lane,
        controlEnv,
      });
      log.info(
        {
          ...base,
          controlEnv,
          dispatched: 1,
          outcome: "removed",
          runId: result.runId,
          workflowUrl: result.workflowUrl,
        },
        EVENT_NAMES.LANE_ONBOARD_COMPLETE
      );
      return;
    }

    const provider =
      row.deployment_provider?.[ctx.lane] === "akash" ? "akash" : "k3s";
    // The FLEET CONTROL ENV owns the akash lane's control cluster (bug.5204/bug.5235): on an
    // isolated fleet (FLEET_CONTROL_ENV=candidate-a) the custodian is candidate-a, not production.
    const controlEnv = controlEnvFor(ctx.lane, provider, env.FLEET_CONTROL_ENV);
    if (operation.action !== "repair" && operation.action !== "add")
      throw Object.assign(new Error("Unknown activation context"), {
        code: "repair_context_conflict",
      });
    if (
      controlEnv !== "candidate-a" &&
      controlEnv !== "preview" &&
      controlEnv !== "production"
    )
      throw Object.assign(new Error("Invalid control environment"), {
        code: "invalid_control_environment",
      });
    if (!row.node_id)
      throw Object.assign(new Error("Missing node identity"), {
        code: "repair_context_conflict",
      });
    // Resolve BOTH own pins before any external effect. A missing pin never establishes birth.
    const renderEnvs = [...new Set<Lane>([controlEnv, ctx.lane])];
    const pins = await Promise.allSettled(
      renderEnvs.map(async (renderEnv) => {
        const subject = {
          parentOwner: ctx.owner,
          parentRepo: ctx.repo,
          env: renderEnv,
          slug: ctx.slug,
        };
        let sha: string | null = null;
        if (operation.action === "repair")
          sha = await deployPlane.readNodeDeployPin(subject);
        else {
          const pin = await deployPlane.readNodeDeployPinState(subject);
          if (pin.kind === "ok") sha = pin.sha;
          else if (
            pin.kind === "missing" &&
            renderEnv === ctx.lane &&
            !(
              parseYaml(operation.baseCatalog ?? "") as CatalogRow
            ).envs?.includes(ctx.lane)
          )
            sha = row.source_sha ?? null;
        }
        if (!sha || !/^[0-9a-f]{40}$/i.test(sha))
          throw new Error("missing_or_invalid");
        return sha;
      })
    );
    const sources = new Map<Lane, string>();
    for (let i = 0; i < pins.length; i++) {
      const pin = pins[i];
      const renderEnv = renderEnvs[i];
      if (!pin || !renderEnv || pin.status === "rejected")
        throw Object.assign(new Error("Required own deploy pin unavailable"), {
          code:
            operation.action === "repair"
              ? "repair_pin_unavailable"
              : "activation_pin_unavailable",
          renderEnv,
          cause:
            pin?.status === "rejected" ? "unavailable_or_invalid" : "missing",
        });
      sources.set(renderEnv, pin.value);
    }
    const custodianSha =
      controlEnv !== ctx.lane ? sources.get(controlEnv) : undefined;
    const laneSha = sources.get(ctx.lane);

    // SUBSTRATE_FOLLOWS_THE_CUSTODIAN — dispatch the custodian's own run first so its
    // `run-node-substrate.sh <controlEnv> <slug>` lane loop creates this lane's database,
    // roles and Temporal namespace under the identities that own them. It is a REPLAY of the
    // custodian's current pin: the substrate work happens, the custodian's app does not move.
    const dispatchReplay = async (
      renderEnv: Lane,
      sourceSha: string
    ): Promise<void> => {
      if (renderEnv === "candidate-a") {
        if (!row.node_id) return;
        const prepared = await deployPlane.prepareNodeRefCandidateFlight({
          parentOwner: ctx.owner,
          parentRepo: ctx.repo,
          nodeId: row.node_id,
          slug: ctx.slug,
          sourceSha,
        });
        const result = await deployPlane.dispatchNodeRefCandidateFlight({
          owner: ctx.owner,
          repo: ctx.repo,
          slug: prepared.slug,
          sourceSha: prepared.sourceSha,
        });
        dispatched += 1;
        completed.push({
          env: renderEnv,
          sourceSha,
          workflowUrl: result.workflowUrl,
        });
        return;
      }
      const result = await deployPlane.promoteNode({
        env: renderEnv,
        parentOwner: ctx.owner,
        parentRepo: ctx.repo,
        slug: ctx.slug,
        sourceSha,
      });
      dispatched += 1;
      completed.push({
        env: renderEnv,
        sourceSha,
        ...(result.runId ? { runId: result.runId } : {}),
        ...(result.workflowUrl ? { workflowUrl: result.workflowUrl } : {}),
      });
    };

    if (controlEnv !== ctx.lane && custodianSha)
      await dispatchReplay(controlEnv, custodianSha);
    if (laneSha) await dispatchReplay(ctx.lane, laneSha);

    log.info(
      {
        ...base,
        controlEnv,
        // REPLAY_NEVER_ADVANCES is only auditable if the rendered shas are in the event.
        ...(custodianSha ? { custodianSha8: custodianSha.slice(0, 8) } : {}),
        ...(laneSha ? { laneSha8: laneSha.slice(0, 8) } : {}),
        dispatched,
        completed,
        outcome: dispatched > 0 ? "dispatched" : "skipped",
      },
      EVENT_NAMES.LANE_ONBOARD_COMPLETE
    );
  } catch (error) {
    log.error(
      {
        ...base,
        dispatched,
        completed,
        renderEnv:
          error && typeof error === "object" && "renderEnv" in error
            ? error.renderEnv
            : undefined,
        pinCause:
          error && typeof error === "object" && "cause" in error
            ? error.cause
            : undefined,
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
