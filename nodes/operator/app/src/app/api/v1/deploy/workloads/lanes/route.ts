// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/lanes`
 * Purpose: Queue awareness and KPIs for a node's deploy lanes (task.5479, story.5159, bug.5621). One
 *   read answers, per `{node, env, workload}`: what serves now, what is in flight and who recorded it,
 *   which releases were superseded or parked in the last 24 hours (and who replaced them), and the
 *   lane's release success ratio, lead time p50/p90 and supersede count (24 h and 7 d).
 * Scope: Read-only. A SIBLING of `GET /api/v1/deploy/workloads` rather than a field on it: that read is
 *   polled by every deploy watcher and stays one cheap desired-row read, while this one adds one bounded
 *   release-history query. Same addressing (`nodeId`, `env`, optional `workload`) and the SAME gate.
 *   It never admits, refuses, orders or writes a release.
 * Invariants:
 *   - AUTHZ_BEFORE_READ: the shared `gate` (production -> `node.promote_production`; preview ->
 *     `node.manage_envs`; candidate-a -> `node.flight` OR `node.manage_envs`) runs before any release row
 *     is read; `envNotServed` then refuses an env or node this deployment does not serve.
 *   - READ_ONLY: SELECT only through the store and the delivery release source; no new table, column or write.
 *   - BOUNDED: one release read per request (node + env scope, `LANE_READ_LOOKBACK_HOURS` back, at most
 *     `MAX_WINDOW_RELEASES` rows, 8 s deadline); a truncated read says so (`truncated: true`).
 * Side-effects: IO (authz check, operator Postgres reads)
 * Links: contracts/deploy.workloads.v1.contract.ts, features/node-deploy/lane-view.ts, ../route.ts
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createDeliveryReleaseSource } from "@/bootstrap/capabilities/node-deploy-release-source";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  DeployLanesQuerySchema,
  type DeployLanesRead,
} from "@/contracts/deploy.workloads.v1.contract";
import { MAX_WINDOW_RELEASES } from "@/features/node-deploy/delivery-kpis";
import {
  buildLaneView,
  LANE_READ_LOOKBACK_HOURS,
} from "@/features/node-deploy/lane-view";
import { buildWorkloadView } from "@/features/node-deploy/release-view";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

import { gate } from "../_lib/gate";
import { envNotServed } from "../_lib/lane";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const READ_DEADLINE_MS = 8000;

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.workloads.lanes",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      const url = new URL(request.url);
      const parsed = DeployLanesQuerySchema.safeParse({
        nodeId: url.searchParams.get("nodeId") ?? undefined,
        env: url.searchParams.get("env") ?? undefined,
        ...(url.searchParams.get("workload")
          ? { workload: url.searchParams.get("workload") }
          : {}),
      });
      if (!parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, env, workload } = parsed.data;
      const g = await gate(sessionUser.id, nodeId, env);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const wrongEnv = envNotServed(env, g.node.id, g.catalogRow);
      if (wrongEnv) return wrongEnv;

      const store = createNodeDeployStore();
      const desiredRows = (await store.listDesired(env)).filter(
        (d) =>
          d.nodeId === g.node.id &&
          d.env === env &&
          (workload === undefined || d.workload === workload)
      );
      const now = new Date();
      const read = await createDeliveryReleaseSource().releases({
        recordedFrom: new Date(
          now.getTime() - LANE_READ_LOOKBACK_HOURS * 3_600_000
        ),
        to: now,
        scope: { nodeId: g.node.id, env },
        maxRows: MAX_WINDOW_RELEASES,
        signal: AbortSignal.timeout(READ_DEADLINE_MS),
      });
      const lanes: DeployLanesRead["lanes"] = [];
      for (const desired of desiredRows) {
        const attemptsNewestFirst = await store.attemptsFor(desired);
        const desiredRelease = await store.getRelease(desired.releaseId);
        const { servingReleaseId } = buildWorkloadView({
          desired,
          release: desiredRelease,
          attemptsNewestFirst,
        });
        lanes.push(
          buildLaneView({
            now,
            desired,
            desiredRelease,
            attemptsNewestFirst,
            servingRelease: servingReleaseId
              ? servingReleaseId === desired.releaseId
                ? desiredRelease
                : await store.getRelease(servingReleaseId)
              : undefined,
            releases: read.rows,
          })
        );
      }
      const body: DeployLanesRead = {
        nodeId: g.node.id,
        env,
        asOf: now.toISOString(),
        truncated: read.truncated,
        lanes,
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
