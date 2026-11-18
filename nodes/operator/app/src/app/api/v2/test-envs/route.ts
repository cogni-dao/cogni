// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v2/test-envs`
 * Purpose: `POST /api/v2/test-envs {nodeId, sourceSha, label?}` records a TEST ENV of a node on candidate-a
 *   (story.5159, `work/designs/test-env-v2.md`): the node's declared `app` at that SHA, under its own workload key
 *   `te<6 letters>` and its own host. It never waits for, and never supersedes, the `app` lane or another test env.
 *   Returns 202 `{testEnvId, host, state}`; `GET|DELETE /api/v2/test-envs/{id}` read and close it.
 * Scope: Authorizes exactly like `POST /api/v1/deploy/workloads` on candidate-a, then delegates to the one
 *   release writer `recordNodeRelease` with a `testEnv` input. It never calls the actuator and never touches DNS:
 *   the sequencer executes the intent.
 * Invariants:
 *   - SAME_GATE_AS_V1: the shared `gate` (candidate-a -> `node.flight` OR `node.manage_envs`) runs first, then
 *     `envNotServed` and `nodeNotOnDeployVerb`, in the same order as v1. Auth is the route handler's
 *     (`getSessionUser`: session or agent API key), the same as v1 handlers; `proxy.ts` is untouched.
 *   - CANDIDATE_A_ONLY: the env is fixed; a test env exists on no other env.
 *   - REFUSAL_NOT_QUEUE: over the node's cap the answer is 409 `test_env_cap`; nothing waits.
 *   - V1_UNCHANGED: nothing here is reachable from a v1 caller; `recordNodeRelease` takes the v1 path when
 *     `testEnv` is absent, and a v1 POST of a te key is `workload_not_declared`.
 * Side-effects: IO (authz check, GitHub App contents read, anonymous ghcr.io manifest read, operator Postgres write)
 * Links: contracts/test-envs.v2.contract.ts, features/node-deploy/test-env.ts, ../../v1/deploy/workloads/route.ts
 * @public
 */

import { NextResponse } from "next/server";
import { recordNodeRelease } from "@/app/_facades/deploy/record-node-release.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  type TestEnvCreated,
  TestEnvCreateInputSchema,
} from "@/contracts/test-envs.v2.contract";
import {
  newTestEnvKey,
  TEST_ENV_ENV,
  testEnvCap,
} from "@/features/node-deploy/test-env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

import { gate } from "../../v1/deploy/workloads/_lib/gate";
import {
  envNotServed,
  nodeNotOnDeployVerb,
} from "../../v1/deploy/workloads/_lib/lane";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KEY_ATTEMPTS = 8;

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.testenvs.create",
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
      const parsed = TestEnvCreateInputSchema.safeParse(body);
      if (!parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, sourceSha, label } = parsed.data;

      const g = await gate(sessionUser.id, nodeId, TEST_ENV_ENV);
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

      // The key is unique across the env (a read resolves the node from it), not just within the node.
      const taken = new Set(
        (await createNodeDeployStore().listDesired(TEST_ENV_ENV)).map(
          (d) => d.workload
        )
      );
      let key: string | undefined;
      for (let i = 0; i < KEY_ATTEMPTS && key === undefined; i++) {
        const candidate = newTestEnvKey();
        if (!taken.has(candidate)) key = candidate;
      }
      if (key === undefined)
        return NextResponse.json({ error: "record_failed" }, { status: 500 });

      const result = await recordNodeRelease({
        node: g.node,
        env: TEST_ENV_ENV,
        workload: key,
        sourceSha,
        createdBy: `user:${sessionUser.id}`,
        mayGenerateSecrets: g.mayGenerateSecrets,
        log: ctx.log,
        reqId: ctx.reqId,
        testEnv: { key, label, cap: testEnvCap(g.catalogRow) },
      });
      if (!result.ok)
        return NextResponse.json(result.body, { status: result.status });
      if (!result.host)
        return NextResponse.json({ error: "record_failed" }, { status: 500 });
      const created: TestEnvCreated = {
        testEnvId: key,
        host: result.host,
        state: "requested",
      };
      return NextResponse.json(created, { status: 202 });
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
