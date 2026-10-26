// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@app/api/v1/deploy/maintenance-cancel`
 * Purpose: Cancel an unexecuted candidate intent using existing operator environment authority.
 * Scope: Strict input, operator RBAC, target identity and typed deploy-plane delegation.
 * Invariants: no caller custody/ref; no target-node role substitution; authorization before Git IO.
 * Side-effects: IO (authorization, node read, operator GitHub App)
 * Links: task.5345, ordinary-node-delivery-boundary
 * @public
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { resolveNodeRef } from "@/features/nodes/node-lookup";
import { serverEnv } from "@/shared/env";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const inputSchema = z.strictObject({
  nodeId: z.string().uuid(),
  env: z.literal("candidate-a"),
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
  expectedDeployHead: z.string().regex(/^[a-f0-9]{40}$/),
  expectedMarkerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine((value) =>
      [...value].every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127
      )
    ),
});
const outputSchema = z.object({
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  previousHead: z.string().regex(/^[a-f0-9]{40}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string(),
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
});
export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.maintenance_cancel",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success)
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    const gate = await resolveNodeAndAuthorize({
      id: "operator",
      userId: sessionUser.id,
      action: "node.manage_envs",
    });
    if (!gate.ok)
      return NextResponse.json(
        { error: gate.errorCode },
        { status: gate.status }
      );
    if (gate.node.slug !== "operator")
      return NextResponse.json({ error: "operator_required" }, { status: 403 });
    const target = await resolveNodeRef(resolveServiceDb(), parsed.data.nodeId);
    if (!target)
      return NextResponse.json({ error: "node_not_found" }, { status: 404 });
    try {
      const result = await createOperatorDeployPlane(
        serverEnv()
      ).cancelCandidateMaintenance({
        ...parsed.data,
        nodeId: target.nodeId,
        slug: target.slug,
        actorId: `user:${sessionUser.id}`,
      });
      const output = outputSchema.parse(result);
      ctx.log.info(
        {
          event: "deploy.maintenance_cancel_complete",
          nodeId: target.nodeId,
          env: "candidate-a",
          operationId: output.operationId,
          commitSha: output.commitSha,
          previousHead: output.previousHead,
        },
        "Cancelled unexecuted candidate intent"
      );
      return NextResponse.json(output);
    } catch (error) {
      const { code, status } = error as { code?: string; status?: number };
      const errorCode =
        typeof code === "string" && /^maintenance_[a-z_]+$/.test(code)
          ? code
          : "maintenance_unavailable";
      ctx.log.warn(
        {
          event: "deploy.maintenance_cancel_refused",
          nodeId: target.nodeId,
          errorCode,
        },
        "Candidate intent cancellation refused"
      );
      return NextResponse.json(
        { error: errorCode },
        {
          status:
            typeof status === "number" &&
            [400, 403, 404, 409, 502, 503].includes(status)
              ? status
              : 502,
        }
      );
    }
  }
);
