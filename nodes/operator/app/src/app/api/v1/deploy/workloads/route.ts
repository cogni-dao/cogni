// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads`
 * Purpose: The node-deploy verb's front door (task.5400, story.5127). `POST` records the intent to
 *   deploy ONE declared workload at a source sha; `GET` reads the desired row, the active attempt and
 *   recent attempts the node-deploy sequencer has produced.
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

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { billingAccounts } from "@cogni/db-schema/refs";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  DeployWorkloadInputSchema,
  DeployWorkloadQuerySchema,
} from "@/contracts/deploy.workloads.v1.contract";
import {
  DeclarationError,
  resolveWorkloadDeclaration,
} from "@/features/node-deploy/declarations";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_SPEC_PATH = ".cogni/repo-spec.yaml";

/**
 * ENV_BINDING (CD4): this deployment's sequencer serves ONE environment (its DEPLOY_ENVIRONMENT).
 * A request for any other env would record a release no sequencer here will ever execute (or, worse,
 * one a differently-wired sequencer would), so it is refused before anything is read or written.
 */
function envNotServed(env: string): NextResponse | undefined {
  const served = serverEnv().DEPLOY_ENVIRONMENT;
  if (!served)
    return NextResponse.json(
      { error: "deploy_environment_not_configured" },
      { status: 503 }
    );
  if (served !== env)
    return NextResponse.json(
      { error: "env_not_served", served },
      { status: 409 }
    );
  return undefined;
}

type Gate =
  | { ok: true; node: { id: string; slug: string } }
  | { ok: false; response: NextResponse };

/** Node lookup + billing account + per-env authorization, shared by POST and GET. */
async function gate(
  userId: string,
  nodeRef: string,
  env: "candidate-a" | "preview" | "production"
): Promise<Gate> {
  const db = resolveServiceDb();
  const [node] = await db
    .select({ id: nodes.id, slug: nodes.slug })
    .from(nodes)
    .where(nodeIdOrSlug(nodeRef))
    .limit(1);
  if (!node)
    return {
      ok: false,
      response: NextResponse.json({ error: "node_not_found" }, { status: 404 }),
    };
  const [billing] = await db
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(eq(billingAccounts.ownerUserId, userId))
    .limit(1);
  if (!billing)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "billing_account_missing" },
        { status: 403 }
      ),
    };
  const authorization = getContainer().authorization;
  if (!authorization)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "authz_unavailable" },
        { status: 503 }
      ),
    };
  const decision = await authorization.check({
    actorId: `user:${userId}`,
    action:
      env === "production" ? "node.promote_production" : "node.manage_envs",
    resource: `node:${node.id}`,
    context: { tenantId: billing.id, nodeId: node.id },
  });
  if (decision.decision !== "allow") {
    const code: AuthzDecisionCode = decision.code;
    return {
      ok: false,
      response: NextResponse.json(
        { error: code },
        { status: code === "authz_unavailable" ? 503 : 403 }
      ),
    };
  }
  return { ok: true, node };
}

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
      logEvent(ctx.log, EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE, {
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
        const attempts = await store.attemptsFor(desired);
        const release = await store.getRelease(desired.releaseId);
        out.push({
          workload: desired.workload,
          desired: {
            state: desired.state,
            releaseId: desired.releaseId,
            sourceSha: release?.sourceSha,
          },
          active: attempts.find((a) => a.phase === "active") ?? null,
          recentAttempts: attempts.slice(0, 10),
        });
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
      logEvent(ctx.log, EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE, {
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
