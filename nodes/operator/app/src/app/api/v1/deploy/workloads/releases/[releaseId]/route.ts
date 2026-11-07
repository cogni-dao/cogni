// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/releases/[releaseId]`
 * Purpose: Follow ONE release end to end (task.5400 observability): its explicit state
 *   (queued|deploying|active|parked|superseded|failed), park reason, lead-time timestamps and every
 *   attempt with its durable step timeline. A node developer reads deploy progress, success and failure
 *   here — never by polling `/version`.
 * Scope: Read-only. Same addressing (`nodeId`, `env`) and the SAME authz gate as `GET
 *   /api/v1/deploy/workloads`; the release must belong to that node and env.
 * Invariants:
 *   - AUTHZ_BEFORE_READ: production -> `node.promote_production`; preview -> `node.manage_envs`;
 *     candidate-a -> `node.flight` (bug.5574); checked before the release row is touched (shared `gate`).
 *   - NO_CROSS_NODE_READ: a release id that belongs to another node or env answers 404 `release_not_found`
 *     exactly like a missing id, so ids are not an oracle for other nodes' deploys.
 *   - ENV_BINDING: `env` must equal this deployment's DEPLOY_ENVIRONMENT (409 `env_not_served`).
 * Side-effects: IO (authz check, operator Postgres read)
 * Links: contracts/deploy.workloads.v1.contract.ts, features/node-deploy/release-view.ts
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  DeployReleaseIdSchema,
  DeployReleaseQuerySchema,
} from "@/contracts/deploy.workloads.v1.contract";
import { buildReleaseDetail } from "@/features/node-deploy/release-view";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import { gate } from "../../_lib/gate";
import { envNotServed } from "../../_lib/lane";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ releaseId: string }>;
}>(
  {
    routeId: "deploy.workloads.release",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      const { releaseId } = (await context?.params) ?? { releaseId: "" };
      const url = new URL(request.url);
      const id = DeployReleaseIdSchema.safeParse(releaseId);
      const parsed = DeployReleaseQuerySchema.safeParse({
        nodeId: url.searchParams.get("nodeId") ?? undefined,
        env: url.searchParams.get("env") ?? undefined,
      });
      if (!id.success || !parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, env } = parsed.data;
      const g = await gate(sessionUser.id, nodeId, env);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const wrongEnv = envNotServed(env, g.node.id, g.catalogRow);
      if (wrongEnv) return wrongEnv;

      const store = createNodeDeployStore();
      const release = await store.getRelease(id.data);
      if (!release || release.nodeId !== g.node.id || release.env !== env)
        return NextResponse.json(
          { error: "release_not_found" },
          { status: 404 }
        );
      const [desired, attempts] = await Promise.all([
        store.getDesired(release),
        store.attemptsFor(release),
      ]);
      return NextResponse.json(
        buildReleaseDetail({
          release,
          desired,
          attemptsNewestFirst: attempts,
        }),
        { status: 200 }
      );
    };
    try {
      response = await run();
      return response;
    } catch {
      response = NextResponse.json({ error: "read_failed" }, { status: 500 });
      return response;
    } finally {
      const status = response?.status ?? 500;
      logEvent(ctx.log, EVENT_NAMES.NODE_WORKLOAD_DEPLOY_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        targetNodeId,
        status,
        outcome: status < 400 ? "success" : "error",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  }
);
