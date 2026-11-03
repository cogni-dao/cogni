// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads`
 * Purpose: The node-deploy verb's front door (task.5400, story.5127). `POST` records the intent to
 *   deploy ONE declared workload at a source sha; `GET` reads the desired row with its explicit
 *   release state (queued|deploying|active|parked|superseded|failed), the active attempt and recent
 *   attempts with their step timelines (`releases/{releaseId}` is the per-release detail).
 * Scope: Authorizes per env, reads the node's `.cogni/repo-spec.yaml` AT `sourceSha` through the
 *   operator GitHub App, resolves the one declared workload, and writes an immutable release plus the
 *   desired row in one transaction. It never calls the actuator and never touches DNS: the sequencer
 *   executes the intent.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production needs `node.promote_production` (`can_promote_production`);
 *     candidate-a and preview need `node.manage_envs` (`can_manage_envs`) — the promote route's pattern —
 *     checked before any GitHub read or write. GET uses the same gate.
 *   - INTENT_ONLY: a 200 means a release row exists, not that anything is deployed.
 *   - DECLARED_AT_THE_SHA: the declaration is read at the requested sha from the node's repo and its
 *     `node_id` must equal the requested node.
 *   - STATE_IS_CREATE_ONCE: a `state` workload that already has a desired row is refused with 409; a
 *     state lease is never replaced by a deploy.
 *   - YELLOW_OPERATOR_ONLY (S1): the repo-spec is read from the operator's parent repo root, so only the
 *     operator node can declare workloads today. Any other node fails `node_mismatch` (422).
 * Side-effects: IO (authz check, GitHub App contents read, operator Postgres write)
 * Links: contracts/deploy.workloads.v1.contract.ts, features/node-deploy/declarations.ts,
 *   docs/spec/rbac.md, hub `node-service-delivery`
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  DeployWorkloadInputSchema,
  DeployWorkloadQuerySchema,
} from "@/contracts/deploy.workloads.v1.contract";
import {
  DeclarationError,
  resolveWorkloadDeclaration,
} from "@/features/node-deploy/declarations";
import { buildWorkloadView } from "@/features/node-deploy/release-view";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

import { envNotServed, gate } from "./_lib/gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_SPEC_PATH = ".cogni/repo-spec.yaml";

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
      const wrongEnv = envNotServed(env);
      if (wrongEnv) return wrongEnv;

      const envConfig = serverEnv();
      const owner = envConfig.NODE_SUBMODULE_PARENT_OWNER;
      const repo = envConfig.NODE_SUBMODULE_PARENT_REPO;
      if (!owner || !repo)
        return NextResponse.json(
          { error: "deploy_target_not_configured" },
          { status: 503 }
        );

      let repoSpecText: string | null;
      try {
        repoSpecText = await createOperatorDeployPlane(envConfig).fetchFileText(
          {
            owner,
            repo,
            path: REPO_SPEC_PATH,
            ref: sourceSha,
          }
        );
      } catch (error) {
        return NextResponse.json(
          {
            error: "declaration_read_failed",
            message:
              error instanceof Error
                ? error.message.slice(0, 200)
                : "read failed",
          },
          { status: 502 }
        );
      }
      if (repoSpecText === null)
        return NextResponse.json(
          { error: "repo_spec_not_found" },
          { status: 422 }
        );

      let spec: ReturnType<typeof resolveWorkloadDeclaration>;
      try {
        spec = resolveWorkloadDeclaration({
          repoSpecText,
          nodeId: node.id,
          env,
          workload,
        });
      } catch (error) {
        if (error instanceof DeclarationError)
          return NextResponse.json(
            { error: error.code, message: error.message },
            { status: error.code === "workload_not_declared" ? 404 : 422 }
          );
        throw error;
      }

      const store = createNodeDeployStore();
      if (spec.kind === "state") {
        const existing = await store.getDesired({
          nodeId: node.id,
          env,
          workload,
        });
        if (existing)
          return NextResponse.json(
            { error: "state_workload_exists" },
            { status: 409 }
          );
      }
      const { release, desired } = await store.recordRelease({
        nodeId: node.id,
        env,
        workload,
        sourceSha,
        spec,
        createdBy: `user:${sessionUser.id}`,
      });
      return NextResponse.json(
        {
          releaseId: release.id,
          nodeId: node.id,
          env,
          workload,
          sourceSha,
          desiredState: desired.state,
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
      const wrongEnv = envNotServed(env);
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
