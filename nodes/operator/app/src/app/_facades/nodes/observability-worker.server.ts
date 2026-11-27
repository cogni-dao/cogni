// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/nodes/observability-worker`
 * Purpose: Bind the shared worker's physical source and project only target-authorized events.
 * Scope: Existing scoped log route extension, never a raw shared-worker read.
 * Invariants: Forced source and two line filters; bounded HTTP; fresh strict output.
 * Side-effects: one local registry read and one Loki read.
 * Links: https://cognidao.org/knowledge/node-log-proxy-contract
 * @public
 */
import { projectEpochWorkerDiagnostic } from "@cogni/scheduler-core";
import {
  createDiagnosticRequestBudget,
  createLedgerPreparation,
  LedgerRequestError,
} from "@/bootstrap/ledger-diagnostic";
import { createLokiReader } from "@/bootstrap/observability.factory";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import {
  type FlightEnv,
  ObservabilityQueryError,
  resolveLogWindow,
  scopeNodeLogQL,
} from "@/features/nodes/observability-logs";
export async function readEpochWorkerLogs(
  request: Request,
  nodeId: string,
  env: FlightEnv
) {
  const budget = createDiagnosticRequestBudget(request);
  let preparation: ReturnType<typeof createLedgerPreparation> | undefined;
  try {
    preparation = createLedgerPreparation(budget, nodeIdOrSlug);
    const node = await preparation.lookup(nodeId);
    preparation.check();
    const source = preparation.workerSource(node, env);
    preparation.finish();
    const params = new URL(request.url).searchParams;
    if (params.has("workload"))
      return { status: 400, body: { error: "invalid_query" } };
    const query = scopeNodeLogQL({
      env,
      nodeId,
      service: "epoch-worker",
      query: params.get("query") ?? undefined,
      epochSource: source,
    });
    const window = resolveLogWindow({
      nowMs: Date.now(),
      minutes: params.get("minutes"),
      start: params.get("start"),
      end: params.get("end"),
    });
    const reader = createLokiReader();
    if (!reader)
      return { status: 503, body: { error: "observability_unwired" } };
    const rawLimit = params.get("limit") ?? "100";
    if (
      !/^\d{1,3}$/.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > 100
    )
      return { status: 400, body: { error: "invalid_query" } };
    budget.signal.throwIfAborted();
    const rows = await reader.queryRange({
      query,
      ...window,
      limit: Number(rawLimit),
      signal: budget.signal,
      bounds: {
        timeoutMs: Math.max(1, budget.deadline - Date.now()),
        maxBytes: 131072,
        maxLineBytes: 2048,
      },
    });
    budget.signal.throwIfAborted();
    const lines: { ts: string; line: string }[] = [];
    for (const row of rows) {
      try {
        const event = projectEpochWorkerDiagnostic(JSON.parse(row.line), {
          targetNodeId: nodeId,
          targetEnv: env,
        });
        if (event) lines.push({ ts: row.ts, line: JSON.stringify(event) });
      } catch {
        /* A malformed or foreign line is not node evidence. */
      }
    }
    const body = {
      nodeId,
      slug: node.slug,
      env,
      query,
      count: lines.length,
      evidence: lines.length ? "observed" : "unknown",
      reasonCode: lines.length ? null : "no_events_in_window",
      lines,
    };
    if (Buffer.byteLength(JSON.stringify(body)) > 131072)
      return { status: 502, body: { error: "loki_response_bounds" } };
    return { status: 200, body };
  } catch (error) {
    const code =
      error instanceof LedgerRequestError ||
      error instanceof ObservabilityQueryError
        ? error.code
        : "loki_query_failed";
    const status =
      error instanceof LedgerRequestError
        ? error.status
        : error instanceof ObservabilityQueryError
          ? 400
          : 502;
    return { status, body: { error: code } };
  } finally {
    preparation?.dispose();
    budget.dispose();
  }
}
