// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/temporal/ledger`
 * Purpose: Authenticated finite node-scoped epoch diagnostic shell.
 * Scope: Request budget, facade and one content-free terminal event.
 * Invariants: No caller native identifiers, credentials, payloads or raw errors.
 * Side-effects: read-only IO through the facade.
 * Links: https://cognidao.org/knowledge/node-temporal-health-contract
 * @public
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ledgerDiagnosticResponse } from "@/app/_facades/nodes/observability-temporal.server";
import { createDiagnosticRequestBudget } from "@/bootstrap/ledger-diagnostic";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const logger = makeLogger();
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const budget = createDiagnosticRequestBudget(request);
  let terminal = {
    status: 503,
    result: "deadline_exceeded",
    calls: 0,
    nodeId: undefined as string | undefined,
  };
  try {
    budget.signal.throwIfAborted();
    const { id } = await context.params;
    budget.signal.throwIfAborted();
    const result = await ledgerDiagnosticResponse(request, id, budget);
    terminal = {
      status: result.status,
      result: result.code,
      calls: result.calls,
      nodeId: result.nodeId,
    };
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    return NextResponse.json({ error: "deadline_exceeded" }, { status: 503 });
  } finally {
    budget.dispose();
    logger.info(
      {
        event: EVENT_NAMES.NODE_OBSERVABILITY_TEMPORAL_COMPLETE,
        reqId: randomUUID(),
        ...terminal,
        durationMs: Date.now() - budget.startedAt,
      },
      EVENT_NAMES.NODE_OBSERVABILITY_TEMPORAL_COMPLETE
    );
  }
}
