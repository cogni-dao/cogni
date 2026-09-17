// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/promote`
 * Purpose: Manual promotion request — operator-dispatched, RBAC-gated promote of a node to preview or production.
 * Scope: Authorizes per-env (`node.promote_production` for production, `node.manage_envs` for preview) then dispatches promote-and-deploy.yml via the operator GitHub App.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: the env's gate — `node.promote_production` (→ `can_promote_production`) for production, `node.manage_envs` (→ `can_manage_envs`) for preview — is checked before any dispatch.
 *   - PROMOTION_RUNS_AS_THE_OPERATOR: dispatch uses the operator GitHub App, never a personal credential.
 *   - APP_PROMOTE_IS_NO_INFRA: promotion reconciles the app digest only (`skip_infra=true`), orthogonal to substrate; Compose/secret/edge changes use a deliberate infra lever.
 *   - PREVIEW_IS_MANUAL_TOO (story.5039): `env=preview` is a SOURCE-ADDRESSED manual promote gated on `node.manage_envs` — the same authority that activates the env; activation + the lane's first write are one product action. Production is unchanged (`node.promote_production`). The auto node-merge hook remains a separate, ungated path.
 *   - ONE_PROMOTION_PRIMITIVE: a `sourceSha` promote is SOURCE-ADDRESSED via `promoteNode` — the
 *     SAME method preview uses (different env + authz only). It reads the catalog row to discriminate
 *     remote-source (fork) vs in-repo and dispatches by `node_source_sha` (fork) or `source_sha`
 *     (in-repo). Production no longer deploys a stale catalog `source_sha` pin for fork nodes (bug.5043).
 * Side-effects: IO (authz check, GitHub workflow_dispatch)
 * Links: docs/spec/node-ci-cd-contract.md § Env-promotion progression, docs/spec/rbac.md, docs/spec/cicd-platform-boundary.md
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { billingAccounts } from "@cogni/db-schema/refs";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getGithubRepo } from "@/shared/config";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const promoteInput = z.object({
  nodeId: z.string().min(1),
  // preview: the activation trigger for a lane's first write (story.5039) — without it, an env
  // activated via the env verb never serves until a node-repo merge manufactures the auto path.
  // production: the RBAC-gated manual dispatch, unchanged.
  env: z.enum(["preview", "production"]),
  sourceSha: z.string().optional(),
});

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "deploy.promote", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const parsed = promoteInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const { nodeId, env, sourceSha } = parsed.data;

    const db = resolveServiceDb();
    const nodeRows = await db
      .select({ id: nodes.id, slug: nodes.slug })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    const node = nodeRows[0];
    if (!node) {
      return NextResponse.json({ error: "node_not_found" }, { status: 404 });
    }

    const billingRows = await db
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, sessionUser.id))
      .limit(1);
    const billingAccount = billingRows[0];
    if (!billingAccount) {
      return NextResponse.json(
        { error: "billing_account_missing" },
        { status: 403 }
      );
    }

    const authorization = getContainer().authorization;
    if (!authorization) {
      return NextResponse.json({ error: "authz_unavailable" }, { status: 503 });
    }

    // AUTHZ SPLIT: production keeps `node.promote_production`. Preview gates on `node.manage_envs`
    // — the SAME authority that activates the env (envs/route.ts); activation + the lane's first
    // write are one product action. The auto merge-hook path (node-preview-promote.server.ts) is
    // V0_NO_RBAC — it rides the candidate-a grant — so this manual gate is strictly TIGHTER than
    // the existing preview write path. A dedicated additive `preview_promoter` → `can_promote_preview`
    // rung (see shared/db/node-access-requests.ts header) is the vNext refinement.
    const decision = await authorization.check({
      actorId: `user:${sessionUser.id}`,
      action:
        env === "production" ? "node.promote_production" : "node.manage_envs",
      resource: `node:${node.id}`,
      context: { tenantId: billingAccount.id, nodeId: node.id },
    });
    if (decision.decision !== "allow") {
      const code: AuthzDecisionCode = decision.code;
      return NextResponse.json(
        { error: code },
        { status: code === "authz_unavailable" ? 503 : 403 }
      );
    }

    const { owner, repo } = getGithubRepo();
    try {
      const deployPlane = createOperatorDeployPlane(serverEnv());
      // ONE_PROMOTION_PRIMITIVE: a caller-supplied sha is SOURCE-ADDRESSED via `promoteNode` — the
      // SAME method the auto merge-hook uses, here with the requested env. It reads the catalog row
      // to discriminate remote-source (fork → node_source_sha) from in-repo (operator/poly →
      // source_sha). Without a sha, production preview-forwards the current `deploy/preview` digest —
      // the raw dispatch (neither source_sha nor node_source_sha) trips the workflow's
      // preview-forward branch. A promote that resolves ZERO targets (env not in the node's catalog
      // envs) still refuses loudly downstream (bug.5203, #2296) — no pre-filtering here.
      const result =
        sourceSha !== undefined
          ? await deployPlane.promoteNode({
              env,
              parentOwner: owner,
              parentRepo: repo,
              slug: node.slug,
              sourceSha,
            })
          : await deployPlane.dispatchNodePromote({
              owner,
              repo,
              env,
              slug: node.slug,
            });
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      // Authz already passed; a dispatch failure (e.g. operator App not installed
      // on the target repo, GitHub timeout) is a downstream fault, not a 500.
      const message =
        error instanceof Error ? error.message : "dispatch failed";
      ctx.log.warn(
        {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          nodeId: node.id,
          slug: node.slug,
          errorCode: "dispatch_failed",
          err: message,
        },
        "deploy.promote dispatch failed"
      );
      return NextResponse.json(
        { error: "dispatch_failed", message },
        { status: 502 }
      );
    }
  }
);
