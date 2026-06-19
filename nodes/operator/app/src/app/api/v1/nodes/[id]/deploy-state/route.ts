// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/deploy-state`
 * Purpose: The operator's read-only SEE flow — GET the per-env deploy state for ONE node so the app
 *   can show "candidate-a ✓ / preview ✓ / production ✗" and a wizard-test junk node (live nowhere) is
 *   visibly distinct from a real one. v0 is probe-backed (public `serving`): coarse live/not-live +
 *   `buildSha` per env, no cluster auth. Swaps to a richer Argo adapter behind `DeployCapability`.
 * Scope: Thin HTTP shell — Cogni-token auth, developer-RBAC gate (the SAME `node.flight` tuple as
 *   flight / flight-status / observability), resolve {id} via the shared node-rbac seam, delegate to
 *   the injected `DeployCapability`. No cluster/GH/Grafana auth.
 * Invariants:
 *   - COGNI_TOKEN_ONLY (getSessionUser = Bearer-first); READ_ONLY; NO_CLUSTER_AUTH.
 *   - DEVELOPER_GATED: requires `node.flight` (→ `can_flight from developer`); fail-closed without a store.
 *   - CAPABILITY_INJECTION: reads `getContainer().deployCapability`; 503 when unwired (no base domain).
 *   - TERMINAL_EVENT: exactly one `feature.node_deploy_state.complete` per request — outcome + status +
 *     nodeId + liveEnvs count only (no secrets, no host list).
 * Side-effects: IO (registry read, authz check, public network probes)
 * Links: src/adapters/server/deploy/probe-deploy.adapter.ts, src/bootstrap/capabilities/deploy.ts,
 *   flight-status/route.ts (same tuple), docs/design/operator-managed-deployments.md § SEE
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { getContainer } from "@/bootstrap/container";
import { getCurrentTraceId } from "@/bootstrap/otel";
import { FLIGHT_ENVS } from "@/features/nodes/flight-status";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Probing three envs (each a /readyz + /version round-trip) can exceed the default budget on a cold edge.
export const maxDuration = 60;

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string }>;
}

const replicaCountsSchema = z.object({
  desired: z.number(),
  ready: z.number(),
});

const nodeDeployStateSchema = z.object({
  env: z.string(),
  node: z.string(),
  sourceSha: z.string().nullable(),
  digest: z.string().nullable(),
  buildSha: z.string().nullable(),
  health: z.enum(["healthy", "degraded", "provisioning", "unknown"]),
  replicas: replicaCountsSchema,
});

const deployStateResponseSchema = z.object({
  nodeId: z.string(),
  slug: z.string(),
  /** Per-env deploy state for this node, one cell per deploy env. */
  envs: z.array(nodeDeployStateSchema),
  /** Convenience rollup: the envs the node is currently live (serving) in. */
  liveEnvs: z.array(z.string()),
});

export type DeployStateResponse = z.infer<typeof deployStateResponseSchema>;

export async function GET(
  request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const startedAt = performance.now();
  const reqCtx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.deploy-state",
    traceId: getCurrentTraceId(),
    session: undefined,
  });

  // Single deterministic terminal event — enums/ids/counts only (no secrets, no host list).
  const complete = (fields: {
    outcome: "success" | "error";
    status: number;
    errorCode?: string;
    nodeId?: string;
    liveEnvs?: number;
  }): void => {
    const payload = {
      reqId: reqCtx.reqId,
      routeId: reqCtx.routeId,
      durationMs: Math.round(performance.now() - startedAt),
      ...fields,
    };
    if (fields.outcome === "success") {
      logEvent(
        reqCtx.log,
        EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE,
        payload,
        EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE
      );
      return;
    }
    const level = fields.status >= 500 ? "error" : "warn";
    reqCtx.log[level](
      { event: EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE, ...payload },
      EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE
    );
  };

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    complete({ outcome: "error", status: 401, errorCode: "unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  // Resolve {id} (UUID or slug) + developer-gate (`node.flight`) via the shared node-rbac seam —
  // fail-closed without a store.
  const gate = await resolveNodeAndAuthorize({
    id,
    userId: sessionUser.id,
    action: "node.flight",
  });
  if (!gate.ok) {
    complete({
      outcome: "error",
      status: gate.status,
      errorCode: gate.errorCode,
    });
    return NextResponse.json(
      { error: gate.errorCode },
      { status: gate.status }
    );
  }
  const node = gate.node;

  // CAPABILITY_INJECTION: read the deploy capability off the container. 503 when unwired (operator
  // DOMAIN/APP_BASE_URL unset — the probe adapter cannot derive hosts).
  const deployCapability = getContainer().deployCapability;
  if (!deployCapability) {
    complete({
      outcome: "error",
      status: 503,
      errorCode: "deploy_unwired",
      nodeId: node.nodeId,
    });
    return NextResponse.json(
      {
        error: "deploy_unwired",
        message:
          "operator DOMAIN/APP_BASE_URL unset — cannot derive node hosts",
      },
      { status: 503 }
    );
  }

  // Fan out over all deploy envs via the capability interface (ADAPTER_SWAPPABLE — no concrete
  // adapter type leaks into the app layer).
  const envs = await Promise.all(
    FLIGHT_ENVS.map((env) =>
      deployCapability.getDeployState({ env, node: node.slug })
    )
  );

  const liveEnvs = envs.filter((e) => e.health === "healthy").map((e) => e.env);

  const body = deployStateResponseSchema.parse({
    nodeId: node.nodeId,
    slug: node.slug,
    envs,
    liveEnvs,
  });

  complete({
    outcome: "success",
    status: 200,
    nodeId: node.nodeId,
    liveEnvs: liveEnvs.length,
  });
  return NextResponse.json(body);
}
