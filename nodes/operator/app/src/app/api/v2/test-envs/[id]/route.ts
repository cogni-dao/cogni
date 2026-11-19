// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v2/test-envs/[id]`
 * Purpose: `GET /api/v2/test-envs/{id}` reads one test env (state, host, requestedAt, readyAt, readyMs, expiresAt);
 *   `DELETE` records the intent to close it (story.5159, `work/designs/test-env-v2.md`).
 * Scope: The id is the workload key, which carries no node, so each call finds the one desired row of that key on
 *   candidate-a and then runs the SAME gate as v1 against that row's node. A DELETE only sets desired `stopped`
 *   through the one writer `requestStop`; the sequencer closes the lease (`stoppedStep`) and reads the close back.
 * Invariants:
 *   - SAME_GATE_AS_V1: `gate` (candidate-a -> `node.flight` OR `node.manage_envs`), `envNotServed`,
 *     `nodeNotOnDeployVerb`, as v1 GET and DELETE. An unknown id is 404 before the gate (it carries no node); a
 *     known id the caller may not touch is the gate's 403. Ids are random, so existence is all that is disclosed.
 *   - TEST_ENVS_ONLY: an id that is not `te<6 letters>` is a 400, so these routes can never stop `app`.
 *   - CLOSE_IS_INTENT_ONLY: DELETE never touches a lease. It is idempotent: an already stopped env answers its state.
 * Side-effects: IO (authz check, operator Postgres reads, one `requestStop` write)
 * Links: contracts/test-envs.v2.contract.ts, features/node-deploy/test-env-view.ts, ../route.ts
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { TestEnvIdSchema } from "@/contracts/test-envs.v2.contract";
import { TEST_ENV_ENV, testEnvState } from "@/features/node-deploy/test-env";
import { buildTestEnvRead } from "@/features/node-deploy/test-env-view";
import type { StorePort } from "@/ports";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

import { gate } from "../../../v1/deploy/workloads/_lib/gate";
import {
  envNotServed,
  nodeNotOnDeployVerb,
} from "../../../v1/deploy/workloads/_lib/lane";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** The one desired row of a test env key on candidate-a, across nodes. */
async function findRow(store: StorePort, id: string) {
  return (await store.listDesired(TEST_ENV_ENV)).find((d) => d.workload === id);
}

export const GET = wrapRouteHandlerWithLogging<Ctx>(
  {
    routeId: "deploy.testenvs.read",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      const { id: raw } = (await context?.params) ?? { id: "" };
      const id = TestEnvIdSchema.safeParse(raw);
      if (!id.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const store = createNodeDeployStore();
      const desired = await findRow(store, id.data);
      if (!desired)
        return NextResponse.json(
          { error: "test_env_not_found" },
          { status: 404 }
        );
      const g = await gate(sessionUser.id, desired.nodeId, TEST_ENV_ENV);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const wrongEnv = envNotServed(TEST_ENV_ENV, g.node.id, g.catalogRow);
      if (wrongEnv) return wrongEnv;
      const [release, attempts] = await Promise.all([
        store.getRelease(desired.releaseId),
        store.attemptsFor(desired),
      ]);
      return NextResponse.json(
        buildTestEnvRead({
          desired,
          release,
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

export const DELETE = wrapRouteHandlerWithLogging<Ctx>(
  {
    routeId: "deploy.testenvs.close",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      const { id: raw } = (await context?.params) ?? { id: "" };
      const id = TestEnvIdSchema.safeParse(raw);
      if (!id.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const store = createNodeDeployStore();
      const desired = await findRow(store, id.data);
      if (!desired)
        return NextResponse.json(
          { error: "test_env_not_found" },
          { status: 404 }
        );
      const g = await gate(sessionUser.id, desired.nodeId, TEST_ENV_ENV);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const wrongEnv = envNotServed(TEST_ENV_ENV, g.node.id, g.catalogRow);
      if (wrongEnv) return wrongEnv;
      const notOnVerb = nodeNotOnDeployVerb(
        TEST_ENV_ENV,
        g.node.id,
        g.catalogRow
      );
      if (notOnVerb) return notOnVerb;

      if (desired.state === "running") {
        const stopped = await store.requestStop(desired, {
          by: `user:${sessionUser.id}`,
          releaseId: desired.releaseId,
        });
        if (!stopped.ok)
          return NextResponse.json(
            {
              error:
                stopped.reason === "release_changed"
                  ? "release_changed"
                  : "test_env_not_found",
            },
            { status: 409 }
          );
      }
      const attempts = await store.attemptsFor(desired);
      return NextResponse.json(
        {
          testEnvId: desired.workload,
          state: testEnvState({
            desiredState: "stopped",
            releaseState: "active",
            attempts,
          }),
        },
        { status: 202 }
      );
    };
    try {
      response = await run();
      return response;
    } catch {
      response = NextResponse.json({ error: "close_failed" }, { status: 500 });
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
