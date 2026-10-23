// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/langfuse-ownership.adapter`
 * Purpose: Authorize legacy observations against the gateway's independent spend receipts.
 * Scope: Read-only LiteLLM HTTP adapter; all credentials and topology are injected.
 * Invariants: Caller metadata never establishes ownership; deleted keys retain receipt attribution;
 *   credentials, receipt bodies and key fingerprints never leave this adapter.
 * Side-effects: bounded HTTP GET to the configured LiteLLM service.
 * Links: src/ports/langfuse-reader.port.ts; spike.5015; LiteLLM cc2386601d4fb3b1f3bccaceb86995dc61163a3a
 * @public
 */

import { z } from "zod";

import type { LangfuseOwnershipPort } from "@/ports";

import {
  LangfuseReadError,
  safeDependencyFailure,
  safeRetryAfter,
} from "./langfuse-read-error";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ReceiptSchema = z.object({
  request_id: z.string(),
  api_key: HashSchema,
  startTime: z.string(),
  metadata: z.unknown(),
});
const ReceiptPageSchema = z.object({
  data: z.array(ReceiptSchema).max(2),
  total: z.number().int().nonnegative(),
});

interface OwnershipOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly operatorMasterKeyHash?: string;
  readonly operatorNodeId?: string;
  readonly operatorEnvironment?: string;
}

export class HttpLangfuseOwnershipVerifier implements LangfuseOwnershipPort {
  private readonly baseUrl: string;

  constructor(private readonly opts: OwnershipOptions) {
    // The host is fixed by bootstrap. Observation fields cannot select a URL or path.
    const base = new URL(opts.baseUrl);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    ) {
      throw new Error("Invalid trace ownership backend");
    }
    base.search = "";
    base.hash = "";
    this.baseUrl = base.toString().replace(/\/+$/, "");
  }

  async verifyObservation(
    nodeId: string,
    environment: string,
    observation: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<boolean> {
    if (observation.type !== "GENERATION") return false;
    const metadata = objectValue(observation.metadata);
    const auth = objectValue(metadata?.user_api_key_auth);
    const hash = HashSchema.safeParse(metadata?.user_api_key_hash);
    if (!metadata || !auth || !hash.success) return false;
    if (metadata.user_api_key !== hash.data || auth.api_key !== hash.data)
      return false;

    const operator = nodeId === this.opts.operatorNodeId;
    const alias = `cogni:${environment}:${nodeId}:app:v1`;
    if (operator) {
      // Master-key calls have no key alias. The fixed service's logical lane is the authority.
      if (
        environment !== this.opts.operatorEnvironment ||
        hash.data !== this.opts.operatorMasterKeyHash ||
        metadata.nodeId !== nodeId ||
        metadata.user_api_key_alias != null ||
        auth.key_alias != null
      )
        return false;
    } else if (
      metadata.user_api_key_alias !== alias ||
      auth.key_alias !== alias
    ) {
      return false;
    }

    const requestId = providerResponseId(observation);
    if (requestId === false) return false;
    const started = Date.parse(String(observation.startTime));
    const requester = objectValue(metadata.requester_metadata);
    const requestedSpend = objectValue(requester?.spend_logs_metadata);
    const runId =
      typeof requester?.request_id === "string"
        ? requester.request_id
        : undefined;
    // Failure callbacks often have no provider response. Correlate their independently stored
    // gateway receipt by authenticated key, terminal time and the run/trace correlation.
    const failureCorrelation =
      !requestId &&
      observation.level === "ERROR" &&
      runId &&
      runId.length <= 256 &&
      requestedSpend?.run_id === runId &&
      requestedSpend.node_id === nodeId &&
      requester?.existing_trace_id === observation.traceId;
    if ((!requestId && !failureCorrelation) || !Number.isFinite(started))
      return false;
    let receiptAnchor = started;
    if (!requestId) {
      const ended =
        typeof observation.endTime === "string"
          ? Date.parse(observation.endTime)
          : Number.NaN;
      if (!Number.isFinite(ended) || ended < started) return false;
      // The pinned failure hook records receipt startTime at terminal datetime.now(),
      // whereas Langfuse retains the original call start/end. Never infer an ID from its UUID.
      receiptAnchor = ended;
    }
    const url = new URL(`${this.baseUrl}/spend/logs/v2`);
    if (requestId) url.searchParams.set("request_id", requestId);
    else {
      url.searchParams.set("api_key", hash.data);
      url.searchParams.set("status_filter", "failure");
    }
    // LiteLLM 1.80.8 only accepts UTC 'YYYY-MM-DD HH:MM:SS', not ISO timestamps.
    url.searchParams.set("start_date", spendDate(receiptAnchor - 2000));
    url.searchParams.set("end_date", spendDate(receiptAnchor + 3000));
    url.searchParams.set("page", "1");
    url.searchParams.set("page_size", "2");

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
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
      const body = await readReceiptBody(response);
      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        throw new LangfuseReadError("observability_invalid_response", 502);
      }
      const parsed = ReceiptPageSchema.safeParse(decoded);
      if (!parsed.success)
        throw new LangfuseReadError("observability_invalid_response", 502);
      if (
        requestId
          ? parsed.data.total !== 1 || parsed.data.data.length !== 1
          : parsed.data.total !== parsed.data.data.length
      )
        return false;
      // Fallback requires the complete cap-two bucket before choosing a uniquely qualified run.
      // Another run does not grant authority or make one exact match ambiguous.
      const matches = parsed.data.data.filter((receipt) => {
        const receiptMetadata = objectValue(receipt.metadata);
        const receiptSpend = objectValue(receiptMetadata?.spend_logs_metadata);
        const receiptStart = Date.parse(receipt.startTime);
        return (
          (requestId
            ? receipt.request_id === requestId
            : receiptMetadata?.status === "failure" &&
              receiptSpend?.run_id === runId &&
              receiptSpend?.node_id === nodeId) &&
          receipt.api_key === hash.data &&
          Number.isFinite(receiptStart) &&
          Math.abs(receiptStart - receiptAnchor) < 2000 &&
          (operator
            ? receiptMetadata?.user_api_key_alias == null
            : receiptMetadata?.user_api_key_alias === alias)
        );
      });
      return matches.length === 1;
    } catch (error) {
      // Fail closed without conflating a failed dependency with valid, unmatched ownership evidence.
      throw safeDependencyFailure(error, signal);
    }
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown =
      typeof value === "string" ? JSON.parse(value) : value;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function spendDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

function providerResponseId(
  observation: Readonly<Record<string, unknown>>
): string | false | undefined {
  const native =
    typeof observation.id === "string"
      ? /^time-\d{2}-\d{2}-\d{2}-\d{6}_(.{1,512})$/.exec(observation.id)?.[1]
      : undefined;
  const output = objectValue(observation.output);
  const responseId =
    typeof output?.id === "string" && output.id.length <= 512
      ? output.id
      : undefined;
  // An overridden generation ID needs the provider response's ID. Conflicting joins are denied.
  if (native && responseId && native !== responseId) return false;
  return native ?? responseId;
}

async function readReceiptBody(response: Response): Promise<string> {
  if (!response.body)
    throw new LangfuseReadError("observability_invalid_response", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        throw new LangfuseReadError("observability_response_too_large", 502);
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
