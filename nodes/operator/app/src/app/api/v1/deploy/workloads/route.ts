// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads`
 * Purpose: The node-deploy verb's front door (task.5400, story.5127). `POST` records the intent to
 *   deploy ONE declared workload at a source sha; `GET` reads the desired row with its explicit
 *   release state (queued|deploying|active|parked|superseded|failed), the active attempt and recent
 *   attempts with their step timelines (`releases/{releaseId}` is the per-release detail).
 * Scope: Authorizes per env, refuses a lane this operator does not control or the catalog has not handed to
 *   the verb, then delegates to the one release writer `recordNodeRelease` (`_facades/deploy/`), which
 *   reads the node's OWN repo-spec and manifests at `sourceSha`, pins the built image digest, checks and
 *   lowers the manifests and writes an immutable release plus the desired row. It never calls the
 *   actuator and never touches DNS: the sequencer executes the intent.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production needs `node.promote_production` (`can_promote_production`);
 *     preview needs `node.manage_envs` (`can_manage_envs`) — the promote route's pattern; candidate-a
 *     needs `node.flight` (`can_flight` <- developer), its self-service proving lane (bug.5574) —
 *     checked before any GitHub read or write. GET uses the same gate.
 *   - ONE_FRONT_DOOR (story.5137): the production operator serves candidate-a, preview and production
 *     for canonical Akash nodes; only `env` differs. `_lib/lane.ts` `envNotServed` refuses (a) an env this
 *     deployment's sequencer does not serve (`NODE_DEPLOY_ENVS`) and (b) a node another fleet owns (catalog
 *     `source_repo` org != NODE_SUBMODULE_PARENT_OWNER) or a lane whose control env is not the fleet control
 *     env. The sequencer applies the same org filter to its slug set.
 *   - ONE_WRITER_PER_NODE_LANE (CD4 c): POST records only when the node's catalog `compute_api[env]` is
 *     `node-deploy` (409 `node_not_on_deploy_verb`); the operator's own canary is exempt.
 *   - Record invariants (INTENT_ONLY, DECLARED_AT_THE_SHA, NODE_DEPLOYS_FROM_ITS_OWN_REPO,
 *     BUILT_IMAGE_IS_DIGEST_PINNED, REFUSED_BEFORE_PAID_CREATE, STATE_IS_CREATE_ONCE, G4_STATE_ADMISSION,
 *     NO_SOURCE_ECHO) live with the writer in `_facades/deploy/record-node-release.server.ts`.
 * Side-effects: IO (authz check, GitHub App contents read, anonymous ghcr.io manifest read, operator
 *   Postgres write)
 * Links: contracts/deploy.workloads.v1.contract.ts, _facades/deploy/record-node-release.server.ts,
 *   _lib/lane.ts, docs/spec/rbac.md, hub `node-service-delivery`,
 *   hub `workload-manifest`
 * @public
 */

import { NextResponse } from "next/server";
import { recordNodeRelease } from "@/app/_facades/deploy/record-node-release.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  DeployWorkloadInputSchema,
  DeployWorkloadQuerySchema,
} from "@/contracts/deploy.workloads.v1.contract";
import { buildWorkloadView } from "@/features/node-deploy/release-view";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

import { gate } from "./_lib/gate";
import { envNotServed, nodeNotOnDeployVerb } from "./_lib/lane";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.workloads.record",
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
      const parsed = DeployWorkloadInputSchema.safeParse(body);
      if (!parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, env, workload, sourceSha } = parsed.data;

      const g = await gate(sessionUser.id, nodeId, env);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const node = g.node;
      const wrongEnv = envNotServed(env, g.node.id, g.catalogRow);
      if (wrongEnv) return wrongEnv;
      // ONE_WRITER_PER_NODE_LANE (CD4): only a lane the catalog hands to this verb is recorded.
      const notOnVerb = nodeNotOnDeployVerb(env, node.id, g.catalogRow);
      if (notOnVerb) return notOnVerb;

      const result = await recordNodeRelease({
        node,
        env,
        workload,
        sourceSha,
        createdBy: `user:${sessionUser.id}`,
        log: ctx.log,
        reqId: ctx.reqId,
      });
      if (!result.ok)
        return NextResponse.json(result.body, { status: result.status });
      return NextResponse.json(
        {
          releaseId: result.releaseId,
          nodeId: node.id,
          env,
          workload,
          sourceSha,
          desiredState: result.desiredState,
        },
        { status: 200 }
      );
    };
    try {
      response = await run();
      return response;
    } catch {
      response = NextResponse.json({ error: "record_failed" }, { status: 500 });
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

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.workloads.read",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      const url = new URL(request.url);
      const parsed = DeployWorkloadQuerySchema.safeParse({
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
      const rows = (await store.listDesired(env)).filter(
        (d) =>
          d.nodeId === g.node.id &&
          d.env === env &&
          (workload === undefined || d.workload === workload)
      );
      const out = [];
      for (const desired of rows) {
        // Release state, park reason, lead-time timestamps and per-attempt step timelines are
        // derived from the rows by `buildWorkloadView` (task.5400 observability).
        out.push(
          buildWorkloadView({
            desired,
            release: await store.getRelease(desired.releaseId),
            attemptsNewestFirst: await store.attemptsFor(desired),
          })
        );
      }
      return NextResponse.json(
        { nodeId: g.node.id, env, workloads: out },
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
