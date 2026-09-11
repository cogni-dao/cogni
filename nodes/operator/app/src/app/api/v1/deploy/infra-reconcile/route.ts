// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/infra-reconcile`
 * Purpose: RBAC-gated production reconcile of the existing shared edge/runtime infrastructure.
 * Scope: Operator node only; dispatches the existing promote-and-deploy workflow via the operator
 *   GitHub App while replaying the current production app source pin.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: `node.promote_production` is checked before dispatch.
 *   - PROMOTION_RUNS_AS_THE_OPERATOR: no caller GitHub credential crosses this route.
 *   - SHARED_INFRA_OPERATOR_ONLY: a node-scoped promoter cannot restart another node's shared VM.
 *   - INFRA_RECONCILE_PRESERVES_APP: caller supplies no SHA/ref; the adapter resolves prod state.
 * Side-effects: IO (authz check, GitHub workflow dispatch)
 * Links: story.5027, docs/spec/cicd-platform-boundary.md
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

const infraReconcileInput = z.strictObject({
  nodeId: z.string().min(1),
  env: z.literal("production"),
});

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.infra_reconcile",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const parsed = infraReconcileInput.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { nodeId, env } = parsed.data;
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
    if (node.slug !== "operator") {
      return NextResponse.json(
        { error: "infra_reconcile_operator_only" },
        { status: 403 }
      );
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
      const result = await createOperatorDeployPlane(
        serverEnv()
      ).reconcileNodeInfra({
        env,
        parentOwner: owner,
        parentRepo: repo,
        slug: node.slug,
      });
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
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
        "deploy.infra_reconcile dispatch failed"
      );
      return NextResponse.json(
        { error: "dispatch_failed", message },
        { status: 502 }
      );
    }
  }
);
