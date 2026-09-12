// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/infra-reconcile`
 * Purpose: RBAC-gated shared-infrastructure control through the existing deploy verb.
 * Scope: Operator node only. Production replays the existing full-infra workflow; candidate-a
 *   classifies one exact reviewed PR as Compose/edge workflow or control-plane GitOps-ref work.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: the temporary bootstrap action `node.promote_production` is
 *     checked before dispatch; story.5028 splits the dedicated infra permission after model boot.
 *   - PROMOTION_RUNS_AS_THE_OPERATOR: no caller GitHub credential crosses this route.
 *   - SHARED_INFRA_OPERATOR_ONLY: a node-scoped promoter cannot restart another node's shared VM.
 *   - INFRA_RECONCILE_PRESERVES_APP: production accepts no SHA/ref and resolves deployed state;
 *     candidate-a changes only infra workflow/ref state, never the app source map.
 *   - CANDIDATE_INFRA_IS_TYPED: candidate-a accepts only sourceSha; lane/repo/ref/workflow/mode
 *     remain server-owned and the adapter validates the PR head plus a single affected-path class.
 *   - ENV_SCOPED_PARENT: the environment's App targets only its configured deployment parent.
 * Side-effects: IO (authz check, GitHub workflow dispatch or Git ref update)
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
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const infraReconcileInput = z.discriminatedUnion("env", [
  z.strictObject({
    nodeId: z.string().min(1),
    env: z.literal("production"),
  }),
  z.strictObject({
    nodeId: z.string().min(1),
    env: z.literal("candidate-a"),
    sourceSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
  }),
]);

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

    const { nodeId } = parsed.data;
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

    // The deployment parent is environment-scoped. Candidate-a's test App is installed only on
    // cogni-test-org and MUST NOT fall back to the production Cogni-DAO/cogni hardcode.
    const envConfig = serverEnv();
    const parentOwner = envConfig.NODE_SUBMODULE_PARENT_OWNER;
    const parentRepo = envConfig.NODE_SUBMODULE_PARENT_REPO;
    if (!parentOwner || !parentRepo) {
      return NextResponse.json(
        { error: "infra_reconcile_target_not_configured" },
        { status: 503 }
      );
    }
    try {
      const deployPlane = createOperatorDeployPlane(envConfig);
      const result =
        parsed.data.env === "candidate-a"
          ? await deployPlane.reconcileNodeInfra({
              env: "candidate-a",
              parentOwner,
              parentRepo,
              slug: "operator",
              sourceSha: parsed.data.sourceSha,
            })
          : await deployPlane.reconcileNodeInfra({
              env: "production",
              parentOwner,
              parentRepo,
              slug: node.slug,
            });
      logEvent(
        ctx.log,
        EVENT_NAMES.DEPLOY_INFRA_RECONCILE_COMPLETE,
        {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          nodeId: node.id,
          slug: node.slug,
          env: result.env,
          status: result.status,
          sourceSha: result.sourceSha,
          ...("lane" in result ? { lane: result.lane } : {}),
          ...("runId" in result ? { runId: result.runId } : {}),
          ...("deploySha" in result ? { deploySha: result.deploySha } : {}),
        },
        EVENT_NAMES.DEPLOY_INFRA_RECONCILE_COMPLETE
      );
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "infra operation failed";
      const deployError =
        error &&
        typeof error === "object" &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { status: number; code: string })
          : null;
      ctx.log.warn(
        {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          nodeId: node.id,
          slug: node.slug,
          parentOwner,
          parentRepo,
          errorCode: deployError?.code ?? "dispatch_failed",
          err: message,
        },
        "deploy.infra_reconcile operation failed"
      );
      return NextResponse.json(
        { error: deployError?.code ?? "dispatch_failed", message },
        { status: deployError?.status ?? 502 }
      );
    }
  }
);
