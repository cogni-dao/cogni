// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/observability-traces`
 * Purpose: Parse native Langfuse narrowing queries without permitting tenant override.
 * Scope: Pure query policy and response-contract validation; no IO.
 * Invariants: 24h windows, 100 rows, exact-match narrowing filters only.
 * Side-effects: none
 * Links: contracts/nodes.langfuse.observations.v1.contract.ts, task.5319
 * @public
 */
import {
  LangfuseFilterSchema,
  LangfuseObservationQuerySchema,
} from "@/contracts/nodes.langfuse.observations.v1.contract";
import type { LangfuseObservationQuery } from "@/ports";

export class TraceQueryError extends Error {
  readonly code = "invalid_trace_query";
}
const FIELD_GROUPS = new Set([
  "core",
  "basic",
  "time",
  "io",
  "metadata",
  "model",
  "usage",
  "prompt",
  "metrics",
  "trace_context",
]);
export function parseTraceQuery(
  params: URLSearchParams,
  nodeId: string
): LangfuseObservationQuery {
  const raw: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in raw) throw new TraceQueryError("Duplicate query parameter");
    raw[key] = value;
  }
  const parsed = LangfuseObservationQuerySchema.safeParse(raw);
  if (!parsed.success)
    throw new TraceQueryError("Unsupported or malformed query");
  const { filter, fields, cursor, ...q } = parsed.data;
  const groups = [...new Set(fields.split(","))].sort();
  if (groups.some((g) => !FIELD_GROUPS.has(g)))
    throw new TraceQueryError("Unsupported field group");
  let filters: unknown = [];
  if (filter) {
    try {
      filters = JSON.parse(filter);
    } catch {
      throw new TraceQueryError("Malformed filter");
    }
  }
  const validated = LangfuseFilterSchema.array().max(8).safeParse(filters);
  if (!validated.success)
    throw new TraceQueryError(
      "Only exact-match observation narrowing is supported"
    );
  const conditions = [...validated.data];
  for (const key of [
    "traceId",
    "sessionId",
    "name",
    "type",
    "level",
  ] as const) {
    const value = q[key];
    if (value)
      conditions.push({ type: "string", column: key, operator: "=", value });
  }
  const types = new Set(
    conditions.filter((f) => f.column === "type").map((f) => f.value)
  );
  const traces = new Set(
    conditions
      .filter((f) => f.column === "traceId")
      .map((f) => f.value.toLowerCase())
  );
  if (types.size > 1 || traces.size > 1)
    throw new TraceQueryError("Conflicting selectors");
  let rootTraceId: string | undefined;
  if (types.has("SPAN")) {
    rootTraceId = [...traces][0];
    if (!rootTraceId || !/^[0-9a-f]{32}$/.test(rootTraceId))
      throw new TraceQueryError("SPAN requires one exact 32-hex traceId");
    for (const f of conditions) {
      if (f.column === "traceId") f.value = rootTraceId;
      if (f.column === "id" && f.value !== `t-${rootTraceId}`)
        throw new TraceQueryError("Conflicting root ID");
    }
  }
  if (q.fromStartTime && q.toStartTime) {
    const width = Date.parse(q.toStartTime) - Date.parse(q.fromStartTime);
    if (width <= 0 || width > 86_400_000)
      throw new TraceQueryError("Window must be positive and at most 24 hours");
  }
  return {
    nodeId,
    environment: q.environment,
    limit: q.limit,
    fields: groups.join(","),
    filters: conditions,
    ...(rootTraceId ? { rootTraceId } : {}),
    ...(q.fromStartTime ? { fromStartTime: q.fromStartTime } : {}),
    ...(q.toStartTime ? { toStartTime: q.toStartTime } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
