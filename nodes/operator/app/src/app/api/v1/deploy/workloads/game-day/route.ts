// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads/game-day`
 * Purpose: The sanctioned out-of-band kill (task.5400, design "weekly game-day kill"). `POST` records a
 *   durable game-day intent for ONE deployed app workload; the node-deploy sequencer — the only process
 *   that drives leases, paying through the actuator — consumes it, closes the active lease via the
 *   actuator delete, logs `node_deploy_game_day_kill {dseq}`, and the ORDINARY reconcile path then
 *   detects the chain-confirmed close and recovers the same release. This route never touches a lease.
 * Scope: Authorizes per env (same gate as the record route), refuses `state`, writes one flag.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production -> `node.promote_production`; other envs -> `node.manage_envs`.
 *   - ENV_BINDING: `env` must equal this deployment's DEPLOY_ENVIRONMENT (409 `env_not_served`).
 *   - STATE_IS_NEVER_KILLED: a `state` workload is refused with 409 `state_workload_protected`; a state
 *     lease holds data and is never auto-replaced.
 *   - INTENT_ONLY: desired state and the release are untouched; no special-casing in recovery.
 * Side-effects: IO (authz check, operator Postgres write of one flag)
 * Links: contracts/deploy.workloads.v1.contract.ts, features/node-deploy/sequencer.ts (`gameDayKill`)
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { DeployWorkloadGameDayInputSchema } from "@/contracts/deploy.workloads.v1.contract";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import { envNotServed, gate } from "../_lib/gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.workloads.game_day",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      const parsed = DeployWorkloadGameDayInputSchema.safeParse(body);
      if (!parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, env, workload } = parsed.data;

      const g = await gate(sessionUser.id, nodeId, env);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const wrongEnv = envNotServed(env);
      if (wrongEnv) return wrongEnv;

      const store = createNodeDeployStore();
      const key = { nodeId: g.node.id, env, workload };
      const desired = await store.getDesired(key);
      if (!desired)
        return NextResponse.json(
          { error: "workload_not_deployed" },
          { status: 404 }
        );
      const release = await store.getRelease(desired.releaseId);
      if (release?.spec.kind === "state")
        return NextResponse.json(
          { error: "state_workload_protected" },
          { status: 409 }
        );
      if (!(await store.requestGameDay(key)))
        return NextResponse.json(
          { error: "workload_not_deployed" },
          { status: 404 }
        );
      return NextResponse.json(
        { nodeId: g.node.id, env, workload, gameDay: "requested" },
        { status: 200 }
      );
    };
    try {
      response = await run();
      return response;
    } catch {
      response = NextResponse.json(
        { error: "game_day_failed" },
        { status: 500 }
      );
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
