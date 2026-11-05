// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@app/api/v1/deploy/infra-reconcile/operations/[operationId]`
 * Purpose: Observe an immutable gateway operation through its custodian.
 * Scope: GET with explicit env; operator node only, same env RBAC as submission.
 * Invariants: No dispatch on read; no test-custodian fallback; unknown stays unknown.
 * Side-effects: Read-only DB, authorization and GitHub native-run observations.
 * Links: bug.5570
 * @public
 */

import { billingAccounts } from "@cogni/db-schema/refs";
import {
  GatewayEnvironmentSchema,
  GatewayOperationIdSchema,
} from "@cogni/operator-gateway-activation";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.infra_reconcile.operation",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    const url = new URL(request.url);
    const operationId = GatewayOperationIdSchema.safeParse(
      url.pathname.split("/").at(-1)
    );
    const env = GatewayEnvironmentSchema.safeParse(url.searchParams.get("env"));
    if (!operationId.success || !env.success)
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    if (!sessionUser)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const db = resolveServiceDb();
    const [node] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.slug, "operator"))
      .limit(1);
    if (!node)
      return NextResponse.json({ error: "node_not_found" }, { status: 404 });
    const [billing] = await db
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, sessionUser.id))
      .limit(1);
    if (!billing)
      return NextResponse.json(
        { error: "billing_account_missing" },
        { status: 403 }
      );
    const authorization = getContainer().authorization;
    if (!authorization)
      return NextResponse.json({ error: "authz_unavailable" }, { status: 503 });
    const decision = await authorization.check({
      actorId: `user:${sessionUser.id}`,
      action:
        env.data === "preview" ? "node.manage_envs" : "node.promote_production",
      resource: `node:${node.id}`,
      context: { tenantId: billing.id, nodeId: node.id },
    });
    if (decision.decision !== "allow")
      return NextResponse.json(
        { error: decision.code },
        {
          status: decision.code === "authz_unavailable" ? 503 : 403,
        }
      );
    const config = serverEnv();
    if (
      !config.NODE_SUBMODULE_PARENT_OWNER ||
      !config.NODE_SUBMODULE_PARENT_REPO
    ) {
      return NextResponse.json(
        { error: "infra_reconcile_target_not_configured" },
        { status: 503 }
      );
    }
    try {
      const result = await createOperatorDeployPlane(
        config
      ).readGatewayActivation({
        parentOwner: config.NODE_SUBMODULE_PARENT_OWNER,
        parentRepo: config.NODE_SUBMODULE_PARENT_REPO,
        operationId: operationId.data,
      });
      if (result.env !== env.data)
        return NextResponse.json(
          { error: "operation_not_found" },
          { status: 404 }
        );
      return NextResponse.json(result);
    } catch (error) {
      const typed = error as { code?: string; status?: number };
      return NextResponse.json(
        { error: typed.code ?? "gateway_observation_unavailable" },
        { status: typed.status ?? 502 }
      );
    }
  }
);
