// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/ops/node-task-echo`
 * Purpose: Operator-self NodeTask dispatch target (story.5008 proof fixture) — the route the operator's own `node-task-selftest` schedule POSTs to, proving the node-schedule loop end to end.
 * Scope: Logs the dispatch (idempotency key + payload) and returns 200. Does not mutate state, run a graph, or implement schedule sync — it is purely the echo endpoint a scheduled NodeTaskWorkflow hits.
 * Invariants:
 *   - DISPATCH_AUTH: Requires Bearer SCHEDULER_API_TOKEN — the same credential the worker dispatches NodeTask under (MVP shared-token principal, task.5034).
 *   - LANDS_IN_LOKI: emits `node_task.echo.received` via pino so a candidate-a dispatch is observable without DB access.
 *   - IDEMPOTENT_TARGET: reads the Idempotency-Key header so a future dedup contract can attach here; today it only logs it.
 * Side-effects: IO (HTTP request/response, structured log).
 * Links: services/scheduler-worker/src/activities/index.ts (dispatchNodeTaskActivity), nodes/operator/.cogni/repo-spec.yaml (schedules.node-task-selftest)
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_AUTH_HEADER_LENGTH = 512;
const MAX_TOKEN_LENGTH = 256;

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;

  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;

  const token = trimmed.slice(7).trim();
  if (token.length > MAX_TOKEN_LENGTH) return null;

  return token;
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "node-task-echo.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const configuredToken = serverEnv().SCHEDULER_API_TOKEN;

    const providedToken = extractBearerToken(
      request.headers.get("authorization")
    );
    if (!providedToken || !safeCompare(providedToken, configuredToken)) {
      ctx.log.warn("Invalid or missing SCHEDULER_API_TOKEN");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idempotencyKey = request.headers.get("idempotency-key") ?? null;
    const payload = await request.json().catch(() => null);

    // App-local event — logged directly (logEvent only types the SHARED EventName).
    ctx.log.info(
      {
        event: "node_task.echo.received",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        idempotencyKey,
        payload,
      },
      "node-task echo"
    );

    return NextResponse.json({ ok: true }, { status: 200 });
  }
);
