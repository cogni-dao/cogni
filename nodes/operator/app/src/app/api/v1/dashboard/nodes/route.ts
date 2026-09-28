// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/dashboard/nodes`
 * Purpose: Authenticated, display-safe node operations overview.
 * Scope: Session gate, facade delegation, and contract validation only.
 * Invariants: AUTH_REQUIRED, CONTRACT_VALIDATED, NO_INFRA_IDENTIFIERS.
 * Side-effects: IO
 * Links: packages/node-contracts/src/nodes.operations-overview.v1.contract.ts, task.5112
 * @public
 */

import { nodeOperationsOverviewOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { listAccessibleNodeOperations } from "@/app/_facades/nodes/operations.server";
import { getCurrentTraceId } from "@/bootstrap/otel";
import { getServerSessionUser } from "@/lib/auth/server";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

export async function GET(request: Request): Promise<NextResponse> {
  const startedAt = performance.now();
  const ctx = createRequestContext({ baseLog, clock }, request, {
    routeId: "dashboard.nodes",
    traceId: getCurrentTraceId(),
    session: undefined,
  });
  const session = await getServerSessionUser();
  if (!session) {
    ctx.log.warn(
      {
        event: EVENT_NAMES.NODE_OPERATIONS_READ_COMPLETE,
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        outcome: "error",
        status: 401,
        errorCode: "unauthorized",
        durationMs: Math.round(performance.now() - startedAt),
      },
      EVENT_NAMES.NODE_OPERATIONS_READ_COMPLETE
    );
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const output = nodeOperationsOverviewOperation.output.parse(
      await listAccessibleNodeOperations(session.id)
    );
    logEvent(ctx.log, EVENT_NAMES.NODE_OPERATIONS_READ_COMPLETE, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      outcome: "success",
      status: 200,
      nodeCount: output.nodes.length,
      unavailableModuleCount: output.nodes.reduce(
        (count, node) =>
          count +
          Object.values(node.modules).filter(
            (module) => module?.state === "unavailable"
          ).length,
        0
      ),
      durationMs: Math.round(performance.now() - startedAt),
    });
    return NextResponse.json(output);
  } catch {
    ctx.log.error(
      {
        event: EVENT_NAMES.NODE_OPERATIONS_READ_COMPLETE,
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        outcome: "error",
        status: 503,
        errorCode: "operations_unavailable",
        durationMs: Math.round(performance.now() - startedAt),
      },
      EVENT_NAMES.NODE_OPERATIONS_READ_COMPLETE
    );
    return NextResponse.json(
      { error: "operations unavailable" },
      { status: 503 }
    );
  }
}
