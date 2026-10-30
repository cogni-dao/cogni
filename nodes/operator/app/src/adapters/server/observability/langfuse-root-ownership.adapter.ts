// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/langfuse-root-ownership`
 * Purpose: Attest only an exact native virtual app root using independently collected Loki receipts.
 * Scope: Fixed Grafana datasource GET; preserves original stream labels and bounded parent deadline.
 * Invariants: No descendant authority, mutable nodeId fallback, credentials or raw dependency errors.
 * Side-effects: bounded read-only HTTP
 * Links: task.5319, graph-execution-host/decorators/observability-executor.decorator.ts
 * @public
 */
import { z } from "zod";
import type { LangfuseOwnershipPort } from "@/ports";
import {
  LangfuseReadError,
  safeDependencyFailure,
  safeRetryAfter,
} from "./langfuse-read-error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE = /^[0-9a-f]{32}$/;
const OUTCOMES = new Set(["success", "error", "aborted", "finalization_lost"]);
const Page = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("streams"),
    result: z
      .array(
        z.object({
          stream: z.record(z.string(), z.string()),
          values: z
            .array(z.tuple([z.string().regex(/^\d{1,20}$/), z.string()]))
            .max(4),
        })
      )
      .max(4),
  }),
});
const object = (value: unknown): Record<string, unknown> | undefined => {
  try {
    const decoded: unknown =
      typeof value === "string" ? JSON.parse(value) : value;
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export class HttpLangfuseRootOwnershipVerifier
  implements LangfuseOwnershipPort
{
  private readonly base: string;
  constructor(
    private readonly opts: {
      grafanaUrl: string;
      token: string;
      now?: () => number;
    }
  ) {
    const url = new URL(opts.grafanaUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid root receipt backend");
    this.base = url.toString().replace(/\/+$/, "");
  }
  async verifyObservation(
    nodeId: string,
    environment: string,
    row: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<boolean> {
    const meta = object(row.metadata),
      output = object(row.output);
    const traceId = row.traceId;
    const started = Date.parse(String(row.startTime));
    const requestId = meta?.reqId,
      graphId = meta?.graphId,
      providerId = meta?.providerId;
    if (
      !UUID.test(nodeId) ||
      !["candidate-a", "preview", "production"].includes(environment) ||
      typeof traceId !== "string" ||
      !TRACE.test(traceId) ||
      row.id !== `t-${traceId}` ||
      row.type !== "SPAN" ||
      row.environment !== "default" ||
      row.parentObservationId !== null ||
      row.isRootObservation !== true ||
      row.name !== "graph-execution" ||
      meta?.nodeId !== nodeId ||
      typeof requestId !== "string" ||
      !UUID.test(requestId) ||
      meta.runId !== requestId ||
      typeof graphId !== "string" ||
      !/^[a-z][a-z0-9_-]*:[a-zA-Z0-9_.:-]{1,128}$/.test(graphId) ||
      providerId !== graphId.split(":")[0] ||
      typeof output?.status !== "string" ||
      !OUTCOMES.has(output.status) ||
      !Number.isFinite(started)
    )
      return false;
    const end = Math.min((this.opts.now ?? Date.now)(), started + 86_400_000);
    if (end < started) return false;
    const url = new URL(
      `${this.base}/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/query_range`
    );
    url.searchParams.set(
      "query",
      `{env="${environment}",service="app",node="${nodeId}"} | json | event=~"langfuse\\\\.trace_(created|completed)" | traceId="${traceId}"`
    );
    url.searchParams.set("start", String(BigInt(started - 2000) * 1_000_000n));
    url.searchParams.set("end", String(BigInt(end) * 1_000_000n));
    url.searchParams.set("limit", "4");
    url.searchParams.set("direction", "forward");
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new LangfuseReadError(
          response.status === 429
            ? "observability_rate_limited"
            : "observability_upstream_error",
          response.status === 429 ? 429 : 502,
          safeRetryAfter(response.headers.get("retry-after"))
        );
      }
      const parsed = Page.safeParse(JSON.parse(await boundedBody(response)));
      if (!parsed.success)
        throw new LangfuseReadError("observability_invalid_response", 502);
      const receipts: Array<{ line: Record<string, unknown>; time: number }> =
        [];
      for (const stream of parsed.data.data.result) {
        if (
          stream.stream.env !== environment ||
          stream.stream.service !== "app" ||
          stream.stream.node !== nodeId
        )
          return false;
        for (const [timestamp, text] of stream.values) {
          const line = object(text),
            time = Number(BigInt(timestamp) / 1_000_000n);
          if (
            !line ||
            line.svcNode !== nodeId ||
            line.traceId !== traceId ||
            line.langfuseTraceId !== traceId ||
            line.reqId !== requestId ||
            !Number.isFinite(time) ||
            time < started - 2000 ||
            time > end ||
            !["langfuse.trace_created", "langfuse.trace_completed"].includes(
              String(line.event)
            )
          )
            return false;
          receipts.push({ line, time });
        }
      }
      if (receipts.length !== 2) return false; // Also rejects limit saturation, duplicate and conflicting pairs.
      const created = receipts.filter(
        (r) => r.line.event === "langfuse.trace_created"
      );
      const terminal = receipts.filter(
        (r) => r.line.event === "langfuse.trace_completed"
      );
      const first = created[0],
        last = terminal[0];
      return (
        created.length === 1 &&
        terminal.length === 1 &&
        !!first &&
        !!last &&
        first.line.graphId === graphId &&
        Math.abs(first.time - started) <= 2000 &&
        last.time >= first.time &&
        last.time <= started + 86_400_000 &&
        last.line.outcome === output.status
      );
    } catch (error) {
      throw safeDependencyFailure(error, signal);
    }
  }
}
async function boundedBody(response: Response): Promise<string> {
  if (!response.body)
    throw new LangfuseReadError("observability_invalid_response", 502);
  if (Number(response.headers.get("content-length")) > 512 * 1024) {
    await response.body.cancel();
    throw new LangfuseReadError("observability_response_too_large", 502);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) {
        await reader.cancel();
        throw new LangfuseReadError("observability_response_too_large", 502);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
