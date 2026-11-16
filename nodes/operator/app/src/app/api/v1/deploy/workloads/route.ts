// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads`
 * Purpose: The node-deploy verb's front door (task.5400, story.5127). `POST` records the intent to
 *   deploy ONE declared workload at a source sha; `GET` reads the desired row with its explicit
 *   release state (queued|deploying|active|parked|superseded|failed), the active attempt and recent
 *   attempts with their step timelines (`releases/{releaseId}` is the per-release detail); `DELETE`
 *   records the intent to STOP one workload (task.5491): the sequencer closes every open lease.
 * Scope: Authorizes per env, refuses a lane this operator does not control or the catalog has not handed to
 *   the verb, then delegates to the one release writer `recordNodeRelease` (`_facades/deploy/`), which
 *   reads the node's OWN repo-spec and manifests at `sourceSha`, pins the built image digest, checks and
 *   lowers the manifests and writes an immutable release plus the desired row. It never calls the
 *   actuator and never touches DNS: the sequencer executes the intent.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production needs `node.promote_production` (`can_promote_production`);
 *     preview needs `node.manage_envs` (`can_manage_envs`) — the promote route's pattern; candidate-a
 *     needs `node.flight` (`can_flight` <- developer) OR `node.manage_envs`, its self-service proving
 *     lane (bug.5574) — checked before any GitHub read or write. GET uses the same gate.
 *   - ONE_FRONT_DOOR (story.5137): the production operator serves candidate-a, preview and production
 *     for canonical Akash nodes; only `env` differs. `_lib/lane.ts` `envNotServed` refuses (a) an env this
 *     deployment's sequencer does not serve (`NODE_DEPLOY_ENVS`) and (b) a node another fleet owns (catalog
 *     `source_repo` org != NODE_SUBMODULE_PARENT_OWNER) or a lane whose control env is not the fleet control
 *     env. The sequencer applies the same org filter to its slug set.
 *   - ONE_WRITER_PER_NODE_LANE (CD4 c): POST records only when the node's catalog `compute_api[env]` is
 *     `node-deploy` (409 `node_not_on_deploy_verb`); no node is exempt (the operator canary is retired, task.5491).
 *   - STOP_IS_INTENT_ONLY (task.5491): `DELETE` sets desired `stopped` through the ONE store writer
 *     `requestStop` and never touches a lease. A `state` workload with an open lease needs
 *     `destroyRetainedData: true` plus the `dseq` of one of its open leases (`planStop`), else 409. The
 *     same gate, lane and verb checks as `POST` run first, so a denial changes nothing.
 *   - Record invariants (INTENT_ONLY, DECLARED_AT_THE_SHA, NODE_DEPLOYS_FROM_ITS_OWN_REPO,
 *     BUILT_IMAGE_IS_DIGEST_PINNED, REFUSED_BEFORE_PAID_CREATE, STATE_IS_CREATE_ONCE, G4_STATE_ADMISSION,
 *     NO_SOURCE_ECHO) live with the writer in `_facades/deploy/record-node-release.server.ts`.
 * Side-effects: IO (authz check, GitHub App contents read, anonymous ghcr.io manifest read, operator
 *   Postgres write)
 * Links: contracts/deploy.workloads.v1.contract.ts, _facades/deploy/record-node-release.server.ts,
 *   _lib/lane.ts, https://cognidao.org/knowledge/authz-port-contract, hub `node-service-delivery`,
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
  DeployWorkloadStopInputSchema,
} from "@/contracts/deploy.workloads.v1.contract";
import { consumersOf } from "@/features/node-deploy/bindings";
import { buildWorkloadView } from "@/features/node-deploy/release-view";
import { planStop } from "@/features/node-deploy/stop-plan";
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
        mayGenerateSecrets: g.mayGenerateSecrets,
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

export const DELETE = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.workloads.stop",
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
      const parsed = DeployWorkloadStopInputSchema.safeParse(body);
      if (!parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, env, workload, destroyRetainedData, dseq } = parsed.data;

      const g = await gate(sessionUser.id, nodeId, env);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const node = g.node;
      const wrongEnv = envNotServed(env, node.id, g.catalogRow);
      if (wrongEnv) return wrongEnv;
      // The same lane rule as POST: only a lane the catalog hands to this verb has rows to stop.
      const notOnVerb = nodeNotOnDeployVerb(env, node.id, g.catalogRow);
      if (notOnVerb) return notOnVerb;

      const store = createNodeDeployStore();
      const key = { nodeId: node.id, env, workload };
      const desired = await store.getDesired(key);
      if (!desired)
        return NextResponse.json(
          { error: "workload_not_deployed" },
          { status: 404 }
        );
      const release = await store.getRelease(desired.releaseId);
      if (!release)
        return NextResponse.json(
          { error: "workload_not_deployed" },
          { status: 404 }
        );
      const isState = release.spec.kind === "state";
      let consumers: readonly string[] = [];
      if (isState) {
        const siblings = await Promise.all(
          (await store.listDesired(env))
            .filter(
              (d) =>
                d.nodeId === node.id &&
                d.workload !== workload &&
                d.state === "running"
            )
            .map(async (d) => {
              const r = await store.getRelease(d.releaseId);
              return {
                workload: d.workload,
                state: d.state,
                bindings: r?.spec.bindings ?? [],
              };
            })
        );
        consumers = consumersOf(workload, siblings);
      }
      const plan = planStop({
        kind: isState ? "state" : "app",
        attempts: await store.attemptsFor(key),
        consumers,
        destroyRetainedData,
        dseq,
      });
      if (!plan.ok)
        return NextResponse.json(
          {
            error: plan.refusal,
            ...(plan.refusal === "state_in_use" ? { consumers } : {}),
          },
          { status: 409 }
        );

      const stopped = await store.requestStop(key, {
        by: `user:${sessionUser.id}`,
        releaseId: desired.releaseId,
        destroyDseq: plan.destroyDseq,
      });
      if (!stopped.ok)
        return NextResponse.json(
          {
            error:
              stopped.reason === "release_changed"
                ? "release_changed"
                : "workload_not_deployed",
          },
          { status: stopped.reason === "release_changed" ? 409 : 404 }
        );
      if (plan.destroyDseq)
        // Operator-local event name: logged by hand like NODE_DEPLOY_SECRET_GENERATION (`logEvent` accepts
        // only the shared registry). Ids and the dseq only.
        ctx.log.warn(
          {
            event: EVENT_NAMES.NODE_WORKLOAD_DESTROY_REQUESTED,
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            targetNodeId: node.id,
            env,
            workload,
            dseq: plan.destroyDseq,
            actorId: `user:${sessionUser.id}`,
          },
          EVENT_NAMES.NODE_WORKLOAD_DESTROY_REQUESTED
        );
      return NextResponse.json(
        {
          nodeId: node.id,
          env,
          workload,
          desiredState: "stopped",
          stop: "requested",
        },
        { status: 200 }
      );
    };
    try {
      response = await run();
      return response;
    } catch {
      response = NextResponse.json({ error: "stop_failed" }, { status: 500 });
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
