// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/node-preview-promote.server`
 * Purpose: Node-merge → preview tie. On a spawned node-repo PR merge, bump the parent
 *   catalog `source_sha` pin + enable auto-merge so flight-preview.yml advances preview —
 *   the same merge→preview model in-repo nodes already get, now for node spawns out of the box.
 * Scope: Webhook-triggered facade. Resolves the node, delegates the GitHub writes to the
 *   operator deploy plane. No promote-and-deploy dispatch here (PREVIEW_VIA_FLIGHT_PREVIEW).
 * Invariants:
 *   - SPAWNED_NODES_ONLY: acts only when the merged-PR repo is a registered external node
 *     (the `nodes` table excludes inline operator/resy/node-template), so in-repo + parent
 *     merges never double-process.
 *   - MERGED_ONLY: fires on `pull_request` action=closed with `merged===true`.
 *   - PIN_IS_PR_HEAD_SHA: pins the PR head SHA — the build the node's PR CI published as
 *     `sha-<headSha>` (the SHA candidate-a already flights). The squash-merge commit on the
 *     node's main has no guaranteed image.
 *   - V0_NO_RBAC: a node cleared auth to reach candidate-a; preview-on-merge rides that grant.
 *     A `node.promote` gate is vNext if a node can earn preview without candidate-a.
 * Side-effects: IO (DB read, GitHub REST/GraphQL via OperatorDeployPlanePort). Fire-and-forget.
 * Links: docs/spec/ci-cd.md, docs/spec/node-ci-cd-contract.md,
 *   src/ports/operator-deploy-plane.port.ts, .github/workflows/flight-preview.yml
 * @public
 */

import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { resolveServiceDb } from "@/bootstrap/container";
import { nodes } from "@/shared/db/nodes";
import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

interface MergedPrContext {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
}

/** Narrow a GitHub `pull_request` webhook payload to a merged-PR context, or null. */
function extractMergedPr(
  payload: Record<string, unknown>
): MergedPrContext | null {
  if (payload.action !== "closed") return null;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!pr || !repo || pr.merged !== true) return null;

  const head = pr.head as Record<string, unknown> | undefined;
  const repoOwner = (repo.owner as Record<string, unknown> | undefined)?.login;
  const repoName = repo.name;
  const prNumber = pr.number;
  const headSha = head?.sha;
  if (
    typeof repoOwner !== "string" ||
    typeof repoName !== "string" ||
    typeof prNumber !== "number" ||
    typeof headSha !== "string"
  ) {
    return null;
  }
  return { owner: repoOwner, repo: repoName, prNumber, headSha };
}

/**
 * Dispatch a node-merge preview promotion from a GitHub `pull_request` webhook payload.
 * Fire-and-forget: errors are logged, never thrown (the webhook 200s regardless).
 */
export function dispatchNodePreviewPromote(
  payload: Record<string, unknown>,
  env: ServerEnv,
  log: Logger
): void {
  const ctx = extractMergedPr(payload);
  if (!ctx) return;

  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    log.debug(
      "node preview promote skipped — GH_REVIEW_APP_ID/PRIVATE_KEY not configured"
    );
    return;
  }
  if (!env.NODE_SUBMODULE_PARENT_OWNER || !env.NODE_SUBMODULE_PARENT_REPO) {
    log.debug(
      "node preview promote skipped — NODE_SUBMODULE_PARENT_{OWNER,REPO} not configured"
    );
    return;
  }

  void promoteNodeToPreview(ctx, env, log);
}

async function promoteNodeToPreview(
  ctx: MergedPrContext,
  env: ServerEnv,
  log: Logger
): Promise<void> {
  try {
    const db = resolveServiceDb();
    const rows = await db
      .select({ id: nodes.id, slug: nodes.slug })
      .from(nodes)
      .where(and(eq(nodes.repoOwner, ctx.owner), eq(nodes.repoName, ctx.repo)))
      .limit(1);
    const node = rows[0];
    // SPAWNED_NODES_ONLY: an unregistered repo (parent monorepo, in-repo node) is handled
    // by flight-preview.yml directly — nothing to do here.
    if (!node) return;

    const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER as string;
    const parentRepo = env.NODE_SUBMODULE_PARENT_REPO as string;

    const result = await createOperatorDeployPlane(env).promoteNodeToPreview({
      parentOwner,
      parentRepo,
      slug: node.slug,
      sourceSha: ctx.headSha,
    });

    // Operator-local event (not in @cogni/node-shared's EventName) → log via the plain
    // logger, the same pattern as NODE_ACCESS_REQUEST_COMPLETE. No reqId: this is a
    // fire-and-forget webhook dispatch, not a request-scoped handler.
    log.info(
      {
        event: EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE,
        nodeId: node.id,
        slug: node.slug,
        repo: `${ctx.owner}/${ctx.repo}`,
        prNumber: ctx.prNumber,
        sourceSha8: ctx.headSha.slice(0, 8),
        status: result.status,
        ...(result.status === "pin_pr_opened"
          ? {
              pinPrNumber: result.prNumber,
              autoMergeEnabled: result.autoMergeEnabled,
            }
          : {}),
      },
      EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE
    );
  } catch (error) {
    log.error(
      {
        event: EVENT_NAMES.NODE_PREVIEW_PROMOTE_COMPLETE,
        repo: `${ctx.owner}/${ctx.repo}`,
        prNumber: ctx.prNumber,
        sourceSha8: ctx.headSha.slice(0, 8),
        error: String(error),
      },
      "node preview promote failed"
    );
  }
}
