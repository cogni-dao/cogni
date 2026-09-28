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
 *   - V0_NO_RBAC: a node cleared auth to reach candidate-a; preview-on-merge rides that grant.
 *     A `node.promote` gate is vNext if a node can earn preview without candidate-a.
 * Side-effects: IO (DB read, GitHub REST/GraphQL via DeployPlanePort). The caller awaits the
 * observed workflow run identity before acknowledging the webhook.
 * Links: docs/spec/ci-cd.md, docs/spec/node-ci-cd-contract.md,
 *   src/ports/deploy-plane.port.ts, .github/workflows/promote-and-deploy.yml
 * @public
 */

import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { resolveServiceDb } from "@/bootstrap/container";
import { nodes } from "@/shared/db/nodes";
import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

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

    // A registered node's default-branch advance owes an observable dispatch. Configuration
    // absence is a failed write, not a successful no-op: throw so the webhook route returns 500
    // and the terminal failure event below carries the exact repo/SHA correlation fields.
    if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
      throw new Error(
        "node preview promote is not configured: GitHub App credentials missing"
      );
    }
    if (!env.NODE_SUBMODULE_PARENT_OWNER || !env.NODE_SUBMODULE_PARENT_REPO) {
      throw new Error(
        "node preview promote is not configured: node submodule parent missing"
      );
    }

    // DISPATCH THE ENV THE CATALOG DECLARES, never a hardcoded one (bug.5203). This facade
    // was written when spawned nodes had a preview slot; #2238 retired every one of them, so
    // each fleet row is now envs:[production] and the dispatch resolved ZERO targets — the run
    // skipped to a green conclusion having deployed nothing. Proven twice on 2026-09-17
    // (beacon run 35175805389, toks5 run 35176388003): a node owner merged a fix, saw green,
    // and nothing shipped.
    //
    // `deploy_envs` is the catalog projection (CATALOG_ENVS_ARE_PROJECTED), so it is the same
    // selector the promote workflow filters on — asking it here is what keeps the two from
    // disagreeing.
    //
    // A node with NO preview env gets NO dispatch, and deliberately does NOT fall through to
    // production: auto-promoting every node merge to production would ship unreviewed code
    // past the human gate that makes production a manual dispatch. Silence here is correct;
    // the SILENT part is what was wrong, so it is logged as its own terminal outcome.
    const deployEnvs = node.deployEnvs ?? [];
    if (!deployEnvs.includes("preview")) {
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
          deployEnvs,
        },
        "node preview promote skipped — node does not deploy to preview"
      );
      return;
    }

    const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
    const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;

    const result = await createOperatorDeployPlane(env).promoteNode({
      env: "preview",
      parentOwner,
      parentRepo,
      slug: node.slug,
      sourceSha: ctx.sourceSha,
    });

    // Operator-local event (not in @cogni/node-shared's EventName) → log via the plain
    // logger, the same pattern as NODE_ACCESS_REQUEST_COMPLETE. The native run identity is the
    // receipt that lets operators follow the exact write this webhook acknowledged.
    log.info(
      {
        event: EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE,
        nodeId: node.id,
        slug: node.slug,
        repo: `${ctx.owner}/${ctx.repo}`,
        sourceSha: ctx.sourceSha,
        sourceSha8: ctx.sourceSha.slice(0, 8),
        trigger: ctx.trigger,
        status: result.status,
        workflowUrl: result.workflowUrl,
        runId: result.runId,
        runUrl: result.runUrl,
        runApiUrl: result.runApiUrl,
      },
      EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE
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
