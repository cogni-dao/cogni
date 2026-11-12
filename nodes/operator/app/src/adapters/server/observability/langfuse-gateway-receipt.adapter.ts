// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/langfuse-gateway-receipt`
 * Purpose: Authorize a sovereign generation recorded by another lane's AI gateway against that
 *   gateway's collector-labeled `ai.gateway.receipt` line in central Loki (bug.5625).
 * Scope: Fixed Grafana datasource GET; validates original stream labels; bounded parent deadline.
 * Invariants: Caller metadata only selects; one receipt under {env=<lane>,service=litellm} with the
 *   exact gateway-stamped lane alias and provider response (or failure run) decides. No credentials,
 *   receipt bodies or key hashes leave this adapter. Receipts carry no key hash (LiteLLM accepts a
 *   stored hash as a bearer token); the gateway-stamped alias is the receipt's identity.
 * Side-effects: bounded read-only HTTP
 * Links: infra/images/litellm/cogni_callbacks.py (writer), langfuse-ownership.adapter.ts (same-lane
 *   native receipts), langfuse-root-ownership.adapter.ts (same Loki trust level)
 * @public
 */
import { z } from "zod";
import type { LangfuseOwnershipPort } from "@/ports";
import { objectValue, providerResponseId } from "./langfuse-ownership.adapter";
import {
  LangfuseReadError,
  safeDependencyFailure,
  safeRetryAfter,
} from "./langfuse-read-error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const LANES = new Set(["candidate-a", "preview", "production"]);
const MAX_LINES = 8;
const MAX_BODY = 512 * 1024;
// Receipts print when the call ends; a long generation can end minutes after it starts.
const MAX_CALL_MS = 15 * 60_000;
// The receipt and the Langfuse row carry the same LiteLLM start/end instants. Retries of one run
// fail ~0.7s apart, so failure receipts bind by exact time, not by a loose window.
const SAME_INSTANT_MS = 50;
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
            .max(MAX_LINES),
        })
      )
      .max(MAX_LINES),
  }),
});

export class HttpLangfuseGatewayReceiptVerifier
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
      throw new Error("Invalid gateway receipt backend");
    this.base = url.toString().replace(/\/+$/, "");
  }

  async verifyObservation(
    nodeId: string,
    environment: string,
    row: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<boolean> {
    if (
      row.type !== "GENERATION" ||
      !UUID.test(nodeId) ||
      !LANES.has(environment) ||
      row.environment !== environment
    )
      return false;
    const metadata = objectValue(row.metadata);
    const auth = objectValue(metadata?.user_api_key_auth);
    const hash = metadata?.user_api_key_hash;
    const alias = `cogni:${environment}:${nodeId}:app:v1`;
    if (
      !metadata ||
      !auth ||
      typeof hash !== "string" ||
      !HASH.test(hash) ||
      metadata.user_api_key !== hash ||
      auth.api_key !== hash ||
      metadata.user_api_key_alias !== alias ||
      auth.key_alias !== alias
    )
      return false;
    const responseId = providerResponseId(row);
    if (responseId === false) return false;
    const started = Date.parse(String(row.startTime));
    const ended =
      typeof row.endTime === "string" ? Date.parse(row.endTime) : Number.NaN;
    const requester = objectValue(metadata.requester_metadata);
    const requestedSpend = objectValue(requester?.spend_logs_metadata);
    const runId =
      typeof requester?.request_id === "string" ? requester.request_id : "";
    // Same failure correlation as the native verifier: no provider response, so the run binds.
    const failure =
      !responseId &&
      row.level === "ERROR" &&
      runId.length > 0 &&
      runId.length <= 256 &&
      requestedSpend?.run_id === runId &&
      requestedSpend.node_id === nodeId &&
      requester?.existing_trace_id === row.traceId;
    if (!Number.isFinite(started) || (!responseId && !failure)) return false;
    if (failure && (!Number.isFinite(ended) || ended < started)) return false;

    const end = Math.min(
      (this.opts.now ?? Date.now)(),
      Number.isFinite(ended) && ended >= started
        ? ended + 5000
        : started + MAX_CALL_MS
    );
    if (end < started) return false;
    const selector = responseId
      ? `| responseId=${logqlString(responseId)}`
      : `| status="failure" | runId=${logqlString(runId)}`;
    const url = new URL(
      `${this.base}/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/query_range`
    );
    url.searchParams.set(
      "query",
      `{env="${environment}",service="litellm"} |= "ai.gateway.receipt" | json | event="ai.gateway.receipt" | keyAlias="${alias}" ${selector}`
    );
    url.searchParams.set("start", String(BigInt(started - 2000) * 1_000_000n));
    url.searchParams.set("end", String(BigInt(end + 1) * 1_000_000n));
    url.searchParams.set("limit", String(MAX_LINES));
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
      let decoded: unknown;
      try {
        decoded = JSON.parse(await boundedBody(response));
      } catch (error) {
        if (error instanceof LangfuseReadError) throw error;
        throw new LangfuseReadError("observability_invalid_response", 502);
      }
      const parsed = Page.safeParse(decoded);
      if (!parsed.success)
        throw new LangfuseReadError("observability_invalid_response", 502);
      let lines = 0;
      let matches = 0;
      for (const stream of parsed.data.data.result) {
        // Original VM-collector labels only. Lease pushes set `source` and no `stream`; this rejects
        // accidental collisions, not a deliberate credential holder (shared-writer limitation).
        if (
          stream.stream.env !== environment ||
          stream.stream.service !== "litellm" ||
          "source" in stream.stream ||
          !stream.stream.stream
        )
          return false;
        for (const [, text] of stream.values) {
          lines++;
          const line = objectValue(text);
          if (line?.event !== "ai.gateway.receipt" || line.keyAlias !== alias)
            return false;
          const receiptStart = Date.parse(String(line.startTime));
          const receiptEnd = Date.parse(String(line.endTime));
          if (
            Number.isFinite(receiptStart) &&
            (responseId
              ? line.status === "success" &&
                line.responseId === responseId &&
                Math.abs(receiptStart - started) < 2000
              : line.status === "failure" &&
                line.runId === runId &&
                line.spendNodeId === nodeId &&
                Math.abs(receiptStart - started) <= SAME_INSTANT_MS &&
                Number.isFinite(receiptEnd) &&
                Math.abs(receiptEnd - ended) <= SAME_INSTANT_MS)
          )
            matches++;
        }
      }
      // A saturated bucket may hide a conflicting receipt; it is a gap, never authority. A receipt
      // not yet shipped is also a gap: the row stays partial and a later read retries it.
      return lines < MAX_LINES && matches === 1;
    } catch (error) {
      throw safeDependencyFailure(error, signal);
    }
  }
}

/** LogQL double-quoted string literal; JSON escaping is a valid subset. */
function logqlString(value: string): string {
  return JSON.stringify(value);
}

async function boundedBody(response: Response): Promise<string> {
  if (!response.body)
    throw new LangfuseReadError("observability_invalid_response", 502);
  if (Number(response.headers.get("content-length")) > MAX_BODY) {
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
      if (size > MAX_BODY) {
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
