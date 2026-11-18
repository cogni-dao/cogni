// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/instances`
 * Purpose: The instance directory (story.5159 step 1, design hub `candidate-pr-lanes`). One read answers,
 *   for a node and env, which instances run right now and the host each serves from:
 *   `{instance, workload, host, releaseId, sourceSha}`. The scheduler-worker resolves a run's `instance`
 *   name here, so a graph run started on the canary calls back to the canary host, never to the app copy
 *   (node-template bug.0050), and `SCHEDULER_API_TOKEN` never goes to a host the run named.
 * Scope: Read-only. A SIBLING of `GET /api/v1/deploy/workloads` and `.../lanes`: same addressing (`nodeId`,
 *   `env`) and the SAME gate. It derives from the existing desired, release and attempt rows
 *   (`features/node-deploy/instance-directory.ts`); there is no table of its own and nothing is written.
 * Invariants:
 *   - AUTHZ_BEFORE_READ: the shared `gate` (production -> `node.promote_production`; preview ->
 *     `node.manage_envs`; candidate-a -> `node.flight` OR `node.manage_envs`) runs before any row is read;
 *     `envNotServed` then refuses an env or node this deployment does not serve. The caller is the operator
 *     session or agent API key the gate already knows. This route does NOT accept `SCHEDULER_API_TOKEN`:
 *     the worker's own read credential is a follow-up (see the PR), so the fleet-wide scheduler token is
 *     never widened to a new route.
 *   - READ_ONLY: SELECT only through the store port; no new table, column or write.
 *   - NO_ENTRY_MEANS_CLOSED: an instance that is stopped, still deploying or never proven is absent.
 *   - HOST_IS_ZONE_BOUND: the host guard needs the fleet's workload zone; without it the read is a 503,
 *     never an unguarded host list.
 * Side-effects: IO (authz check, operator Postgres reads)
 * Links: contracts/deploy.instances.v1.contract.ts, features/node-deploy/instance-directory.ts, ../workloads/route.ts
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  DeployInstancesQuerySchema,
  type DeployInstancesRead,
} from "@/contracts/deploy.instances.v1.contract";
import { buildInstanceDirectory } from "@/features/node-deploy/instance-directory";
import { serverEnv } from "@/shared/env";
import {
  resolveWorkloadZoneBinding,
  WorkloadZoneConfigError,
} from "@/shared/node-registry/fleet-ownership";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

import { gate } from "../workloads/_lib/gate";
import { envNotServed } from "../workloads/_lib/lane";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.instances.list",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      const url = new URL(request.url);
      const parsed = DeployInstancesQuerySchema.safeParse({
        nodeId: url.searchParams.get("nodeId") ?? undefined,
        env: url.searchParams.get("env") ?? undefined,
      });
      if (!parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, env } = parsed.data;
      const g = await gate(sessionUser.id, nodeId, env);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const wrongEnv = envNotServed(env, g.node.id, g.catalogRow);
      if (wrongEnv) return wrongEnv;

      const envConfig = serverEnv();
      let binding: ReturnType<typeof resolveWorkloadZoneBinding>;
      try {
        binding = resolveWorkloadZoneBinding({
          fleetOwner: envConfig.NODE_SUBMODULE_PARENT_OWNER,
          zoneName: envConfig.NODE_DEPLOY_WORKLOAD_ZONE,
        });
      } catch (error) {
        if (error instanceof WorkloadZoneConfigError)
          return NextResponse.json({ error: error.code }, { status: 503 });
        throw error;
      }

      const instances = await buildInstanceDirectory({
        store: createNodeDeployStore(),
        nodeId: g.node.id,
        slug: g.node.slug,
        env,
        binding,
      });
      const body: DeployInstancesRead = {
        nodeId: g.node.id,
        env,
        asOf: new Date().toISOString(),
        instances,
      };
      return NextResponse.json(body, { status: 200 });
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
