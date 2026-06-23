// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/promote`
 * Purpose: Production promotion request — operator-dispatched, RBAC-gated promote of a node to production.
 * Scope: Authorizes `node.promote_production` then dispatches promote-and-deploy.yml via the operator GitHub App. Does NOT promote preview (that is the ungated node-merge → flight-preview path).
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: `node.promote_production` (→ `can_promote_production`) is checked before any dispatch.
 *   - PROMOTION_RUNS_AS_THE_OPERATOR: dispatch uses the operator GitHub App, never a personal credential.
 *   - APP_PROMOTE_IS_NO_INFRA: promotion reconciles the app digest only (`skip_infra=true`), orthogonal to substrate; Compose/secret/edge changes use a deliberate infra lever.
 *   - PRODUCTION_ONLY_V0: only `env=production` is accepted; preview auto-promote is the operator merge-hook path (ungated). A `can_promote_preview` rung is additive when manual preview promotes arrive.
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
  // v0: production only. Preview auto-promote is the ungated node-merge → flight-preview path.
  env: z.literal("production"),
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

    const decision = await authorization.check({
      actorId: `user:${sessionUser.id}`,
      action: "node.promote_production",
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
      // SAME method preview uses, here with env=production. It reads the catalog row to discriminate
      // remote-source (fork → node_source_sha) from in-repo (operator/poly → source_sha). Without a
      // sha, production preview-forwards the current `deploy/preview` digest — the raw dispatch
      // (neither source_sha nor node_source_sha) trips the workflow's preview-forward branch.
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
