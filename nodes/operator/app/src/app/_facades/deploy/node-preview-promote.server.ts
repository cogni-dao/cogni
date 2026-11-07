// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/node-preview-promote.server`
 * Purpose: Node-merge → preview tie. On a spawned node-repo PR merge, promote the node to
 *   preview the same way production promotes — the operator dispatches promote-and-deploy at
 *   env=preview SOURCE-ADDRESSED by the merged node commit sha (`node_source_sha`), writing ZERO
 *   commits to main. Gives node spawns the same merge→preview model in-repo nodes get, out of
 *   the box.
 * Scope: Webhook-triggered facade. Resolves the node, delegates the source-addressed dispatch
 *   to the operator deploy plane (ONE_PROMOTION_PRIMITIVE; task.5022 — no main write; the pin
 *   lands on deploy/preview).
 * Invariants:
 *   - SPAWNED_NODES_ONLY: acts only when the pushed repo resolves to a registered node
 *     row by slug. The parent monorepo and in-repo nodes are unregistered here, so their
 *     merges never double-process — flight-preview.yml owns them. Every registered node
 *     (including node-template, a seeded registry row since story.5009 that deploys via the
 *     monorepo catalog — task.5087 retired its external-repo carve-out) promotes preview
 *     through this hook.
 *   - MAIN_ADVANCE_ONLY: the webhook route invokes this on `push`; only a push to the repository's
 *     declared default branch advances preview. One canonical signal avoids duplicate dispatches
 *     while covering direct and merge-queue merges (bug.5010 / Poly #65).
 *   - PIN_IS_MAIN_SHA: pins the canonical commit observed on node main. Merge-queue CI builds that
 *     commit before merge; a missing image fails loudly downstream instead of deploying an
 *     off-main PR head that can silently roll preview and production backward.
 *   - ONE_WRITER_PER_NODE_LANE (story.5137, task.5410): when the node's catalog cell
 *     `compute_api.preview` is `node-deploy`, the merge records an env=preview release through
 *     `recordNodeRelease` (the SAME writer `POST /api/v1/deploy/workloads` uses) for every declared
 *     `kind: app` workload at the pushed main sha, with the operator as the principal. It never
 *     dispatches the legacy workflow for that node. Latest-wins is the store's desired-row swap;
 *     a redelivered push for a sha already desired is logged `duplicate`. State workloads are never
 *     touched (create-once). Before recording it applies the verb route's lane decision
 *     (`laneRefusal`: served env, fleet ownership, control env) and requires the pushed repo to be the
 *     catalog's source repo; otherwise it logs `skipped_<reason>` and records nothing. A node with no `node-deploy` preview
 *     cell is logged `skipped_no_preview_env`; the legacy workflow dispatch was deleted (task.5411).
 *   - V0_NO_RBAC: a node cleared auth to reach candidate-a; preview-on-merge rides that grant.
 *     A `node.promote` gate is vNext if a node can earn preview without candidate-a.
 * Side-effects: IO (DB read, GitHub REST/GraphQL via DeployPlanePort). The caller awaits the
 * observed workflow run identity before acknowledging the webhook.
 * Links: docs/spec/ci-cd.md, docs/spec/node-ci-cd-contract.md,
 *   src/ports/deploy-plane.port.ts, .github/workflows/promote-and-deploy.yml
 * @public
 */

import { lowerWorkloadManifests } from "@cogni/repo-spec";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { laneRefusal } from "@/app/api/v1/deploy/workloads/_lib/lane";
import { createNodeCatalog } from "@/bootstrap/capabilities/node-catalog";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import {
  createDeclarationReader,
  createNodeSourceResolver,
} from "@/bootstrap/capabilities/node-source-resolver";
import { resolveServiceDb } from "@/bootstrap/container";
import { isNodeOnDeployVerb } from "@/features/compute/node-compute-api";
import { readWorkloadDeclarations } from "@/features/node-deploy/read-declarations";
import { nodes } from "@/shared/db/nodes";
import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

import { recordNodeRelease } from "./record-node-release.server";

/** The principal on a release the merge webhook records: the operator itself, never a human. */
export const MERGE_WEBHOOK_PRINCIPAL = "operator:merge-webhook";

interface NodeMainAdvanceContext {
  readonly owner: string;
  readonly repo: string;
  readonly sourceSha: string;
  readonly trigger: "push";
}

/** Narrow a GitHub `push` payload to a default-branch advance, or null. */
function extractMainPush(
  payload: Record<string, unknown>
): NodeMainAdvanceContext | null {
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!repo) return null;
  const repoOwner = (repo.owner as Record<string, unknown> | undefined)?.login;
  const repoName = repo.name;
  const defaultBranch = repo.default_branch;
  const ref = payload.ref;
  const after = payload.after;
  if (
    typeof repoOwner !== "string" ||
    typeof repoName !== "string" ||
    typeof defaultBranch !== "string" ||
    ref !== `refs/heads/${defaultBranch}` ||
    typeof after !== "string" ||
    !/^[0-9a-f]{40}$/i.test(after) ||
    /^0{40}$/.test(after)
  ) {
    return null;
  }
  return {
    owner: repoOwner,
    repo: repoName,
    sourceSha: after,
    trigger: "push",
  };
}

/**
 * Dispatch a node preview promotion from a GitHub default-branch advance.
 * Failures are logged and rethrown so the webhook route cannot acknowledge an unobserved dispatch.
 */
export async function dispatchNodePreviewPromote(
  payload: Record<string, unknown>,
  env: ServerEnv,
  log: Logger
): Promise<void> {
  const ctx = extractMainPush(payload);
  if (!ctx) return;
  await promoteNodeToPreview(ctx, env, log);
}

async function promoteNodeToPreview(
  ctx: NodeMainAdvanceContext,
  env: ServerEnv,
  log: Logger
): Promise<void> {
  try {
    const db = resolveServiceDb();
    const rows = await db
      .select({
        id: nodes.id,
        slug: nodes.slug,
        deployEnvs: nodes.deployEnvs,
      })
      .from(nodes)
      // A wizard node's fork is named after its slug (`forkFromTemplate` → `name: slug`), and the
      // seeded node-template row's repo name == its slug — so the pushed repo name == the node
      // slug. `nodes.repoOwner/repoName` may be the PARENT deploy monorepo, NOT the node's own
      // source repo — so resolve by slug. Every registered node deploys via the monorepo catalog
      // (node-template's own-repo carve-out retired by task.5087), so any row that resolves here
      // gets the same merge→preview promote.
      .where(eq(nodes.slug, ctx.repo))
      .limit(1);
    const node = rows[0];
    // SPAWNED_NODES_ONLY: an unregistered repo (parent monorepo, in-repo node) is handled
    // by flight-preview.yml directly — nothing to do here.
    if (!node) {
      log.info(
        {
          event: EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE,
          repo: `${ctx.owner}/${ctx.repo}`,
          sourceSha: ctx.sourceSha,
          sourceSha8: ctx.sourceSha.slice(0, 8),
          trigger: ctx.trigger,
          status: "skipped_unregistered_repo",
        },
        "node preview promote skipped — repository is not a registered node"
      );
      return;
    }

    // ONE_WRITER_PER_NODE_LANE: a node whose preview cell is `node-deploy` records a release.
    const catalogRow = (await createNodeCatalog().entryFor(node.id))?.row;
    if (
      catalogRow !== undefined &&
      isPreviewOnDeployVerb(catalogRow) // parse-only; unreadable rows are legacy
    ) {
      await recordPreviewReleases(
        ctx,
        { id: node.id, slug: node.slug },
        catalogRow,
        env,
        log
      );
      return;
    }

    // task.5411 (CD9): the legacy promote-and-deploy dispatch is deleted. Every node's preview
    // lane is either a `node-deploy` cell (recorded above) or absent from the catalog, so a node
    // without one does not deploy to preview. Never fall through to production: production stays
    // a manual, human-gated release.
    log.info(
      {
        event: EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE,
        nodeId: node.id,
        slug: node.slug,
        repo: `${ctx.owner}/${ctx.repo}`,
        sourceSha: ctx.sourceSha,
        sourceSha8: ctx.sourceSha.slice(0, 8),
        trigger: ctx.trigger,
        status: "skipped_no_preview_env",
        deployEnvs: node.deployEnvs ?? [],
      },
      "node preview promote skipped — node does not deploy to preview"
    );
  } catch (error) {
    log.error(
      {
        event: EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE,
        repo: `${ctx.owner}/${ctx.repo}`,
        sourceSha: ctx.sourceSha,
        sourceSha8: ctx.sourceSha.slice(0, 8),
        trigger: ctx.trigger,
        status: "failed",
        error: String(error),
      },
      "node preview promote failed"
    );
    throw error;
  }
}

function isPreviewOnDeployVerb(catalogRow: unknown): boolean {
  try {
    return isNodeOnDeployVerb({ catalog: catalogRow, environment: "preview" });
  } catch {
    return false;
  }
}

/**
 * Record an env=preview release for every declared app workload at the pushed main sha.
 * Throws when any workload is refused or unreadable so the webhook cannot acknowledge a merge that
 * recorded nothing; a node that declares no app workload is a logged skip.
 */
async function recordPreviewReleases(
  ctx: NodeMainAdvanceContext,
  node: { id: string; slug: string },
  catalogRow: unknown,
  env: ServerEnv,
  log: Logger
): Promise<void> {
  const base = {
    event: EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE,
    nodeId: node.id,
    slug: node.slug,
    repo: `${ctx.owner}/${ctx.repo}`,
    sourceSha: ctx.sourceSha,
    sourceSha8: ctx.sourceSha.slice(0, 8),
    trigger: ctx.trigger,
    env: "preview",
    path: "node-deploy",
  };
  // CD4 (a)+(b): the SAME lane decision the verb route applies before this writer.
  const refusal = laneRefusal("preview", node.id, catalogRow, env);
  if (refusal) {
    log.info(
      {
        ...base,
        status: `skipped_${refusal.reason}`,
        httpStatus: refusal.status,
      },
      "node preview release skipped — this operator does not serve the lane"
    );
    return;
  }
  const owner = env.NODE_SUBMODULE_PARENT_OWNER;
  const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
  if (!owner || !parentRepo)
    throw new Error(
      "node preview release is not configured: node submodule parent missing"
    );
  const source = await createNodeSourceResolver().resolveNodeSource({
    nodeId: node.id,
    parentOwner: owner,
    parentRepo,
  });
  // PUSH_REPO_IS_THE_CATALOG_REPO: the sha is read from the catalog's source repo, so the pushed
  // repo must BE that repo; a same-named fork elsewhere must never choose what gets recorded.
  if (
    ctx.owner.toLowerCase() !== source.owner.toLowerCase() ||
    ctx.repo.toLowerCase() !== source.repo.toLowerCase()
  ) {
    log.info(
      {
        ...base,
        status: "skipped_repo_mismatch",
        sourceRepo: `${source.owner}/${source.repo}`,
      },
      "node preview release skipped — pushed repo is not the node's catalog source repo"
    );
    return;
  }
  const workloads = await declaredAppWorkloads(ctx, source, env);
  if (workloads.length === 0) {
    log.info(
      { ...base, status: "skipped_no_app_workloads" },
      "node preview release skipped — no app workload declared at this sha"
    );
    return;
  }
  const store = createNodeDeployStore();
  const failures: string[] = [];
  for (const workload of workloads) {
    try {
      const desired = await store.getDesired({
        nodeId: node.id,
        env: "preview",
        workload,
      });
      const current = desired
        ? await store.getRelease(desired.releaseId)
        : null;
      if (
        current &&
        current.sourceSha.toLowerCase() === ctx.sourceSha.toLowerCase()
      ) {
        log.info(
          { ...base, workload, status: "duplicate", releaseId: current.id },
          "node preview release skipped — sha already desired"
        );
        continue;
      }
      const result = await recordNodeRelease({
        node,
        env: "preview",
        workload,
        sourceSha: ctx.sourceSha,
        createdBy: MERGE_WEBHOOK_PRINCIPAL,
        log,
      });
      if (result.ok) {
        log.info(
          {
            ...base,
            workload,
            status: "recorded",
            releaseId: result.releaseId,
          },
          "node preview release recorded"
        );
      } else {
        failures.push(workload);
        log.error(
          {
            ...base,
            workload,
            status: "record_refused",
            httpStatus: result.status,
            reason: result.body.error,
          },
          "node preview release refused"
        );
      }
    } catch (error) {
      // One workload's DB/runtime fault must not starve the others; throw once after the loop.
      failures.push(workload);
      log.error(
        { ...base, workload, status: "record_failed", error: String(error) },
        "node preview release failed"
      );
    }
  }
  if (failures.length > 0)
    throw new Error(`preview release refused for: ${failures.join(", ")}`);
}

/** Names of the declared `kind: app` workloads at the sha (state workloads are create-once, never merge-driven). */
async function declaredAppWorkloads(
  ctx: NodeMainAdvanceContext,
  source: { owner: string; repo: string },
  env: ServerEnv
): Promise<string[]> {
  const read = await readWorkloadDeclarations(createDeclarationReader(env), {
    owner: source.owner,
    repo: source.repo,
    sourceSha: ctx.sourceSha,
  });
  if (read.kind === "repo_spec_not_found")
    throw new Error("repo-spec not found at the pushed sha");
  if (read.kind === "refused") throw new Error(read.message);
  return lowerWorkloadManifests(read.manifests, {
    env: "preview",
    pendingImage: `pending:sha-${ctx.sourceSha.toLowerCase()}`,
  })
    .filter((w) => w.kind === "app")
    .map((w) => w.name);
}
