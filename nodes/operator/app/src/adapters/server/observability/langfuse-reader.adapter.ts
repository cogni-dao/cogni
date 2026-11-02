// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/langfuse-reader.adapter`
 * Purpose: Bounded native v2 observation reads with independently verified node ownership,
 *   scoped signed cursors and privacy projection; retains the legacy trace-summary reader.
 * Scope: IO only. Credentials/URL are constructor inputs (no env loading here — bootstrap wires them).
 * Invariants: READ_ONLY; independently verified ownership; finite depth16/17 and row-budgeted privacy projection; no credential-bearing errors.
 * Side-effects: network (fetch to Langfuse)
 * Links: src/ports/langfuse-reader.port.ts, src/bootstrap/observability.factory.ts
 * @public
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { scrubStringContent } from "@cogni/node-shared";
import { z } from "zod";

import type {
  LangfuseObservationPage,
  LangfuseObservationQuery,
  LangfuseOwnershipPort,
  LangfuseReaderPort,
  LangfuseTraceQuery,
  LangfuseTraceSummary,
} from "@/ports";

import {
  LangfuseReadError,
  safeDependencyFailure,
  safeRetryAfter,
} from "./langfuse-read-error";

export class HttpLangfuseReader implements LangfuseReaderPort {
  private static readonly activeReads = new Map<string, number>();
  private readonly base: string;
  private readonly authHeader: string;
  private readonly cursorKey: Buffer;
  private readonly ownership: LangfuseOwnershipPort | undefined;
  private readonly rootOwnership: LangfuseOwnershipPort | undefined;
  private readonly operatorNodeId: string | undefined;
  private readonly operatorEnvironment: string | undefined;

  constructor(opts: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
    ownership?: LangfuseOwnershipPort;
    rootOwnership?: LangfuseOwnershipPort;
    operatorNodeId?: string;
    operatorEnvironment?: string;
  }) {
    this.cursorKey = createHash("sha256")
      .update(`langfuse-reader-cursor-v1:${opts.secretKey}`)
      .digest();
    this.ownership = opts.ownership;
    this.rootOwnership = opts.rootOwnership;
    this.operatorNodeId = opts.operatorNodeId;
    this.operatorEnvironment = opts.operatorEnvironment;
    this.base = opts.baseUrl.replace(/\/+$/, "");
    // Langfuse public API uses HTTP Basic: publicKey as user, secretKey as password.
    this.authHeader = `Basic ${Buffer.from(
      `${opts.publicKey}:${opts.secretKey}`
    ).toString("base64")}`;
  }

  /** Native v2 reads never authorize content by tag, name, or caller metadata alone. */
  async listObservations(
    query: LangfuseObservationQuery
  ): Promise<LangfuseObservationPage> {
    const active = HttpLangfuseReader.activeReads.get(query.nodeId) ?? 0;
    if (active >= 2)
      throw new LangfuseReadError("observability_rate_limited", 429, "6");
    HttpLangfuseReader.activeReads.set(query.nodeId, active + 1);
    try {
      return await this.readObservations(query);
    } finally {
      const left = (HttpLangfuseReader.activeReads.get(query.nodeId) ?? 1) - 1;
      if (left) HttpLangfuseReader.activeReads.set(query.nodeId, left);
      else HttpLangfuseReader.activeReads.delete(query.nodeId);
    }
  }

  private async readObservations(
    query: LangfuseObservationQuery
  ): Promise<LangfuseObservationPage> {
    const rootTraceId = query.rootTraceId;
    const verifier = rootTraceId ? this.rootOwnership : this.ownership;
    if (!verifier) throw new LangfuseReadError("attribution_unavailable", 503);
    const ownsLocalOperator = query.nodeId === this.operatorNodeId;
    if (ownsLocalOperator && query.environment !== this.operatorEnvironment) {
      // A shared Langfuse project does not imply access to another lane's receipt service.
      throw new LangfuseReadError("attribution_unavailable", 503);
    }
    if (!ownsLocalOperator && this.operatorEnvironment !== "production") {
      // Sovereign aliases use the production-custodied gateway's independent spend receipts.
      // A candidate/preview process cannot infer those receipts from its local LiteLLM instance.
      throw new LangfuseReadError("attribution_unavailable", 503);
    }
    const backendEnvironment = rootTraceId
      ? "default"
      : ownsLocalOperator
        ? this.operatorEnvironment
        : "production";
    const { cursor, ...scopeQuery } = query;
    const scope = createHash("sha256")
      .update(
        JSON.stringify({
          base: this.base,
          plan: rootTraceId
            ? { kind: "exact-root", id: `t-${rootTraceId}` }
            : { kind: "generations" },
          binding: {
            operatorNodeId: this.operatorNodeId ?? null,
            operatorEnvironment: this.operatorEnvironment ?? null,
            backendEnvironment,
          },
          ...scopeQuery,
        })
      )
      .digest("hex");
    let from = query.fromStartTime;
    let to = query.toStartTime;
    let upstreamCursor: string | undefined;
    if (cursor) {
      const saved = this.openCursor(cursor);
      if (saved.scope !== scope)
        throw new LangfuseReadError("invalid_trace_cursor", 400);
      from = saved.from;
      to = saved.to;
      upstreamCursor = saved.upstream;
    }
    to ??= new Date().toISOString();
    from ??= new Date(Date.parse(to) - 86_400_000).toISOString();
    if (
      Date.parse(to) <= Date.parse(from) ||
      Date.parse(to) - Date.parse(from) > 86_400_000
    ) {
      throw new LangfuseReadError("invalid_trace_window", 400);
    }
    from = new Date(from).toISOString();
    to = new Date(to).toISOString();
    const signal = AbortSignal.timeout(15_000);
    // Node metadata and key aliases are candidate selectors; independent receipts decide reach.
    const ownershipFilter =
      rootTraceId || ownsLocalOperator
        ? {
            type: "stringObject",
            column: "metadata",
            key: "nodeId",
            operator: "=",
            value: query.nodeId,
          }
        : {
            type: "stringObject",
            column: "metadata",
            key: "user_api_key_alias",
            operator: "=",
            value: `cogni:${query.environment}:${query.nodeId}:app:v1`,
          };
    const filters = [
      ownershipFilter,
      ...(rootTraceId
        ? [
            {
              type: "string",
              column: "id",
              operator: "=",
              value: `t-${rootTraceId}`,
            },
            { type: "string", column: "type", operator: "=", value: "SPAN" },
          ]
        : []),
      {
        type: "string",
        column: "environment",
        operator: "=",
        value: backendEnvironment,
      },
      { type: "datetime", column: "startTime", operator: ">=", value: from },
      { type: "datetime", column: "startTime", operator: "<", value: to },
      ...query.filters,
    ];
    const url = new URL(`${this.base}/api/public/v2/observations`);
    url.searchParams.set("filter", JSON.stringify(filters));
    url.searchParams.set(
      "fields",
      [
        ...new Set([
          "core",
          "basic",
          "metadata",
          "io",
          "model",
          "trace_context",
          ...query.fields.split(","),
        ]),
      ].join(",")
    );
    url.searchParams.set(
      "expandMetadata",
      "user_api_key_auth,requester_metadata"
    );
    url.searchParams.set("parseIoAsJson", "false");
    if (upstreamCursor) url.searchParams.set("cursor", upstreamCursor);
    // `limit` is a ceiling, not a requirement to fill a response. Small native subpages keep
    // verbose generation IO usable; retries always start at the same upstream cursor/window.
    const pageSizes = rootTraceId
      ? [2]
      : [...new Set([Math.min(query.limit, 10), Math.min(query.limit, 2), 1])];
    const MAX_PAGE_BYTES = 8 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 3 * MAX_PAGE_BYTES;
    let consumedBytes = 0;
    let page: z.infer<typeof NativePageSchema> | undefined;
    let upstreamPageSize = pageSizes[0] ?? 1;
    let upstreamByteLimited = false;
    for (const pageSize of pageSizes) {
      upstreamPageSize = pageSize;
      const attemptUrl = new URL(url);
      attemptUrl.searchParams.set("limit", String(pageSize));
      const res = await fetch(attemptUrl, {
        headers: { Authorization: this.authHeader },
        signal,
        redirect: "error",
      }).catch((error: unknown) => {
        throw safeDependencyFailure(error, signal);
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new LangfuseReadError(
          res.status === 429
            ? "observability_rate_limited"
            : "observability_upstream_error",
          res.status === 429 ? 429 : 502,
          safeRetryAfter(res.headers.get("retry-after"))
        );
      }
      try {
        const body = await readBounded(
          res,
          Math.min(MAX_PAGE_BYTES, MAX_TOTAL_BYTES - consumedBytes),
          (bytes) => {
            consumedBytes += bytes;
          }
        );
        page = NativePageSchema.parse(JSON.parse(body));
        if (page.data.length > pageSize)
          throw new LangfuseReadError("observability_invalid_response", 502);
        break;
      } catch (error) {
        const failure = safeDependencyFailure(error, signal);
        if (
          failure.code !== "observability_response_too_large" ||
          pageSize === 1 ||
          consumedBytes >= MAX_TOTAL_BYTES ||
          signal.aborted
        )
          throw failure;
        upstreamByteLimited = true;
      }
    }
    if (!page)
      throw new LangfuseReadError("observability_response_too_large", 502);
    const data: Record<string, unknown>[] = [];
    const ambiguousRoot =
      !!rootTraceId && (page.data.length > 1 || !!page.meta.cursor);
    let unavailable = ambiguousRoot ? Math.max(1, page.data.length) : 0;
    let truncated = false;
    // Allocate each row a fair share of the response budget, leaving meta/cursor headroom.
    const rowBudget = Math.floor((1024 * 1024 - 32768) / query.limit);
    for (const row of ambiguousRoot ? [] : page.data) {
      const time = Date.parse(String(row.startTime));
      if (
        !Number.isFinite(time) ||
        time < Date.parse(from) ||
        time >= Date.parse(to) ||
        row.environment !== backendEnvironment ||
        !matchesFilters(row, query.filters) ||
        (rootTraceId &&
          (row.id !== `t-${rootTraceId}` ||
            row.traceId !== rootTraceId ||
            row.type !== "SPAN" ||
            row.parentObservationId !== null ||
            row.isRootObservation !== true ||
            row.name !== "graph-execution")) ||
        !(await verifier.verifyObservation(
          query.nodeId,
          query.environment,
          row,
          signal
        ))
      ) {
        unavailable++;
        continue;
      }
      let projected: Record<string, unknown>;
      try {
        projected = projectObservation(row, query.fields, rowBudget, () => {
          truncated = true;
        });
      } catch (error) {
        if (error instanceof LangfuseReadError) throw error;
        // Allocation/serialization failures never become malformed-JSON success or raw errors.
        throw new LangfuseReadError("observability_invalid_response", 502);
      }
      if (jsonBytes(projected, rowBudget) > rowBudget) {
        // Withhold over-budget content rather than corrupt a JSON/string payload or skip pagination rows.
        for (const field of ["input", "output", "modelParameters"]) {
          if (field in projected) projected[field] = null;
        }
        truncated = true;
      }
      if (jsonBytes(projected, rowBudget) > rowBudget) {
        throw new LangfuseReadError("observability_response_too_large", 502);
      }
      data.push(projected);
    }
    const next =
      !rootTraceId && page.meta.cursor
        ? this.sealCursor({
            scope,
            from,
            to,
            upstream: page.meta.cursor,
            expires: Date.now() + 3_600_000,
          })
        : null;
    return {
      data,
      meta: {
        cursor: next,
        cogni: {
          contractVersion: "langfuse-observations-v2.1",
          nodeId: query.nodeId,
          logicalEnvironment: query.environment,
          fromStartTime: from,
          toStartTime: to,
          partial:
            unavailable > 0 ||
            truncated ||
            (upstreamPageSize < query.limit && !!page.meta.cursor),
          upstreamPageSize,
          upstreamByteLimited,
          attributionUnavailable: unavailable,
          privacyProjected: true,
          truncated,
        },
      },
    };
  }

  private sealCursor(value: z.infer<typeof CursorSchema>): string {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${createHmac("sha256", this.cursorKey).update(body).digest("base64url")}`;
  }
  private openCursor(cursor: string): z.infer<typeof CursorSchema> {
    try {
      const [body, signature, extra] = cursor.split(".");
      if (!body || !signature || extra) throw new Error();
      const expected = createHmac("sha256", this.cursorKey)
        .update(body)
        .digest();
      const received = Buffer.from(signature, "base64url");
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw new Error();
      const saved = CursorSchema.parse(
        JSON.parse(Buffer.from(body, "base64url").toString())
      );
      if (saved.expires < Date.now()) throw new Error();
      return saved;
    } catch {
      throw new LangfuseReadError("invalid_trace_cursor", 400);
    }
  }

  async listTraces(query: LangfuseTraceQuery): Promise<LangfuseTraceSummary[]> {
    const url = new URL(`${this.base}/api/public/traces`);
    // NODE_PIN: the nodeId tag is the per-node read boundary — caller cannot widen it.
    url.searchParams.set("tags", query.nodeId);
    url.searchParams.set("limit", String(query.limit));
    if (query.environment) {
      url.searchParams.set("environment", query.environment);
    }

    const res = await fetch(url, {
      headers: { Authorization: this.authHeader },
      // Bound the call so a hung upstream can't pin the route.
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`langfuse list traces failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as LangfuseTracesResponse;
    // Defense-in-depth: Langfuse is queried with tags=<nodeId>, but the operator
    // still enforces the node boundary on the response before returning data.
    const rows = (json.data ?? []).filter((t) =>
      (t.tags ?? []).includes(query.nodeId)
    );
    return rows.map((t) => ({
      id: t.id,
      name: t.name ?? null,
      timestamp: t.timestamp,
      tags: t.tags ?? [],
      nodeId: typeof t.metadata?.nodeId === "string" ? t.metadata.nodeId : null,
    }));
  }
}

interface LangfuseTracesResponse {
  readonly data?: ReadonlyArray<{
    readonly id: string;
    readonly timestamp: string;
    readonly name?: string | null;
    readonly tags?: readonly string[];
    readonly metadata?: { readonly nodeId?: unknown } | null;
  }>;
}

const CursorSchema = z
  .object({
    scope: z.string(),
    from: z.string().datetime(),
    to: z.string().datetime(),
    upstream: z.string().max(8192),
    expires: z.number(),
  })
  .strict();
const NativePageSchema = z.object({
  data: z
    .array(
      z
        .object({
          id: z.string(),
          traceId: z.string().nullable(),
          startTime: z.string(),
          environment: z.string().nullable(),
          type: z.string(),
        })
        .passthrough()
    )
    .max(100),
  meta: z.object({ cursor: z.string().max(8192).nullish() }),
});
async function readBounded(
  response: Response,
  max: number,
  consume: (bytes: number) => void
): Promise<string> {
  if (!response.body)
    throw new LangfuseReadError("observability_invalid_response", 502);
  const declared = Number(response.headers.get("content-length"));
  if (max <= 0 || declared > max) {
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
      consume(value.byteLength);
      if (size > max) {
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
function matchesFilters(
  row: Readonly<Record<string, unknown>>,
  filters: LangfuseObservationQuery["filters"]
): boolean {
  return filters.every((f) => row[f.column] === f.value);
}
// Native groups: langfuse/langfuse ebffeda716c1fb70d552cbe310729d02c97bd7b9
// packages/shared/src/domain/observation-field-groups.ts. userId is intentionally withheld.
const FIELD_GROUPS: Readonly<Record<string, readonly string[]>> = {
  core: [
    "id",
    "traceId",
    "startTime",
    "endTime",
    "projectId",
    "parentObservationId",
    "type",
    "modelId",
    "inputPrice",
    "outputPrice",
    "totalPrice",
  ],
  basic: [
    "name",
    "level",
    "statusMessage",
    "version",
    "environment",
    "bookmarked",
    "public",
    "sessionId",
    "isRootObservation",
  ],
  time: ["completionStartTime", "createdAt", "updatedAt"],
  io: ["input", "output"],
  metadata: ["metadata"],
  model: [
    "model",
    "internalModelId",
    "modelParameters",
    "modelId",
    "inputPrice",
    "outputPrice",
    "totalPrice",
  ],
  usage: ["usageDetails", "costDetails", "totalCost", "usagePricingTierName"],
  prompt: ["promptId", "promptName", "promptVersion"],
  metrics: ["latency", "timeToFirstToken"],
  trace_context: ["tags", "traceName", "release"],
};
const METADATA_KEYS = new Set([
  "nodeId",
  "environment",
  "graphId",
  "graphName",
  "runId",
  "sessionId",
  "reqId",
  "requestId",
  "source",
  "revision",
  "sourceRevision",
  "graphVersion",
  "status",
  "errorCode",
]);
const PRIVATE_KEY =
  /auth|cookie|password|secret|credential|token|^key$|bearer|private.?key|api.?key|billing.?account|requester|hidden.?params|email|user.?id/i;
// A linear pre-pass bounds the inherited email/credential regexes' maximum candidate length.
// It preserves ordinary long prose and JSON structure; only oversized unbroken leaf tokens go.
const MAX_UNBROKEN_CONTENT_RUN = 2048;
function boundContentRuns(
  value: string,
  onTruncated: () => void,
  budget: number
): string {
  let runStart = 0;
  let copiedThrough = 0;
  const parts: string[] = [];
  let bytes = 0;
  const append = (part: string): boolean => {
    bytes += Buffer.byteLength(part);
    if (bytes > budget) return false;
    parts.push(part);
    return true;
  };
  for (let i = 0; i <= value.length; i++) {
    const code = value.charCodeAt(i);
    const whitespace =
      code <= 32 ||
      code === 160 ||
      code === 5760 ||
      (code >= 8192 && code <= 8202) ||
      code === 8232 ||
      code === 8233 ||
      code === 8239 ||
      code === 8287 ||
      code === 12288 ||
      code === 65279;
    if (i !== value.length && !whitespace) continue;
    if (i - runStart > MAX_UNBROKEN_CONTENT_RUN) {
      if (
        !append(value.slice(copiedThrough, runStart)) ||
        !append("[WITHHELD: oversized token]")
      ) {
        onTruncated();
        return REDACTED;
      }
      copiedThrough = i;
      onTruncated();
    }
    runStart = i + 1;
  }
  if (parts.length === 0) return value;
  if (!append(value.slice(copiedThrough))) {
    onTruncated();
    return REDACTED;
  }
  return parts.join("");
}
const REDACTED = "[REDACTED]";
const SERIALIZED_REDACTED = JSON.stringify(REDACTED);
const highSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

// Count native JSON bytes before allocating its string. Inputs are native JSON values.
// Iterators avoid a second recursion/stack limit on pre-scrub native containers.
function jsonBytes(value: unknown, limit: number): number {
  let bytes = 0;
  const add = (count: number): void => {
    bytes += count;
  };
  const string = (text: string): void => {
    add(2);
    for (let i = 0; i < text.length && bytes <= limit; i++) {
      const code = text.charCodeAt(i);
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        add(2);
      else if (code < 32) add(6);
      else if (highSurrogate(code)) {
        if (lowSurrogate(text.charCodeAt(i + 1))) {
          add(4);
          i++;
        } else add(6);
      } else if (lowSurrogate(code)) add(6);
      else add(code < 128 ? 1 : code < 2048 ? 2 : 3);
    }
  };
  const stack: Iterator<unknown>[] = [[value].values()];
  while (stack.length && bytes <= limit) {
    const next = stack[stack.length - 1]?.next();
    if (!next || next.done) {
      stack.pop();
      continue;
    }
    const item = next.value;
    if (typeof item === "string") string(item);
    else if (item === null || item === undefined) add(4);
    else if (typeof item === "number" || typeof item === "boolean")
      add(String(item).length);
    else if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      stack.push(item.values());
    } else if (typeof item === "object") {
      const record = item as Record<string, unknown>,
        keys = Object.keys(record);
      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (bytes > limit) break;
        string(key);
        add(1);
      }
      stack.push(
        (function* () {
          for (const key of keys) yield record[key];
        })()
      );
    }
  }
  return bytes;
}

// Row-local KMP state: one lazy prefix backing per pattern, reused ONE WAY for escaped
// matching, and one reusable difference buffer. Capacity follows the admitted row budget.
function contentPolicy(
  privateValues: readonly string[],
  budget: number,
  onTruncated: () => void
) {
  const invalid = (): never => {
    throw new LangfuseReadError("observability_invalid_response", 502);
  };
  const allocate = (length: number): Int32Array => {
    try {
      return new Int32Array(length);
    } catch {
      return invalid();
    }
  };
  const patterns = privateValues.map((raw) => {
    // Escaped bytes upper-bound escaped UTF-16 units. Count before constructing the form.
    const escapedBytes = jsonBytes(raw, budget + 2) - 2;
    let escapedLength = 0;
    if (escapedBytes <= budget) {
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        if (
          code === 34 ||
          code === 92 ||
          code === 8 ||
          code === 9 ||
          code === 10 ||
          code === 12 ||
          code === 13
        )
          escapedLength += 2;
        else if (code < 32) escapedLength += 6;
        else if (highSurrogate(code) && lowSurrogate(raw.charCodeAt(i + 1))) {
          escapedLength += 2;
          i++;
        } else
          escapedLength += highSurrogate(code) || lowSurrogate(code) ? 6 : 1;
      }
    }
    const rawFits = raw.length <= budget && Buffer.byteLength(raw) <= budget;
    return {
      raw,
      rawFits,
      escapedLength,
      text: rawFits ? raw : "",
      prefix: undefined as Int32Array | undefined,
      ready: false,
    };
  });
  let escapedPhase = false;
  let difference: Int32Array | undefined;
  const withhold = (): string => {
    onTruncated();
    return REDACTED;
  };
  const fits = (source: string): boolean => Buffer.byteLength(source) <= budget;
  const table = (pattern: (typeof patterns)[number]): Int32Array => {
    if (!pattern.prefix)
      pattern.prefix = allocate(
        Math.max(
          pattern.rawFits ? pattern.raw.length : 0,
          pattern.escapedLength
        )
      );
    const prefix = pattern.prefix;
    if (!pattern.ready) {
      prefix.fill(0);
      const text = pattern.text;
      for (let i = 1, j = 0; i < text.length; i++) {
        while (j && text[i] !== text[j]) j = prefix[j - 1] ?? 0;
        if (text[i] === text[j]) j++;
        prefix[i] = j;
      }
      pattern.ready = true;
    }
    return prefix;
  };
  const scan = (source: string, cover = false): boolean => {
    if (!fits(source)) return invalid();
    if (cover) {
      if (escapedPhase) return invalid();
      difference?.fill(0, 0, source.length + 1);
    }
    let found = false;
    for (const pattern of patterns) {
      const text = pattern.text;
      if (!text.length || text.length > source.length) continue;
      const prefix = table(pattern);
      for (let i = 0, j = 0; i < source.length; i++) {
        while (j && source[i] !== text[j]) j = prefix[j - 1] ?? 0;
        if (source[i] === text[j]) j++;
        if (j !== text.length) continue;
        found = true;
        if (!cover) return true;
        let start = i - text.length + 1,
          end = i + 1;
        if (
          start > 0 &&
          highSurrogate(source.charCodeAt(start - 1)) &&
          lowSurrogate(source.charCodeAt(start))
        )
          start--;
        if (
          end < source.length &&
          highSurrogate(source.charCodeAt(end - 1)) &&
          lowSurrogate(source.charCodeAt(end))
        )
          end++;
        difference ??= allocate(budget + 1);
        if (difference) {
          difference[start] = (difference[start] ?? 0) + 1;
          difference[end] = (difference[end] ?? 0) - 1;
        }
        j = prefix[j - 1] ?? 0;
      }
    }
    return found;
  };
  // Every raw fallback must be safe in both its native and serialized representation.
  if (scan(REDACTED) || scan(SERIALIZED_REDACTED)) invalid();
  const union = (source: string): string => {
    if (!fits(source)) return withhold();
    if (!scan(source, true)) return source;
    const parts: string[] = [];
    let bytes = 0,
      active = 0,
      start = 0,
      covered = false;
    const append = (part: string): boolean => {
      bytes += Buffer.byteLength(part);
      if (bytes > budget) return false;
      parts.push(part);
      return true;
    };
    for (let i = 0; i <= source.length; i++) {
      active += difference?.[i] ?? 0;
      if (active > 0 && !covered) {
        if (!append(source.slice(start, i)) || !append(REDACTED))
          return withhold();
        covered = true;
      } else if (active === 0 && covered) {
        start = i;
        covered = false;
      }
    }
    if (!append(source.slice(start))) return withhold();
    return parts.join("");
  };
  const leaf = (source: string): string => {
    const first = union(source);
    const bounded = boundContentRuns(first, onTruncated, budget);
    if (!fits(bounded)) return withhold();
    const cleaned = scrubStringContent(bounded);
    if (!fits(cleaned)) return withhold();
    const result = union(cleaned);
    return scan(result) ? REDACTED : result;
  };
  const serialize = (value: unknown): string => {
    if (jsonBytes(value, budget) > budget) return withhold();
    const text = JSON.stringify(value);
    return scan(text) ? withhold() : text;
  };
  const scrub = (value: unknown, depth = 0): unknown => {
    if (depth > 16) return withhold();
    if (typeof value === "string") {
      if (!fits(value)) return withhold();
      const objectLike = /^[\s]*[[{]/.test(value);
      const quoted = /^[ \t\n\r]*"/.test(value);
      if (objectLike || quoted) {
        if (scan(value)) return withhold();
        let parsed: unknown;
        // Only native parsing belongs in this catch. Privacy/allocation failures propagate.
        try {
          parsed = JSON.parse(value);
        } catch {
          if (objectLike) return REDACTED;
          const cleaned = leaf(value);
          return cleaned === value ? value : withhold();
        }
        return serialize(scrub(parsed, depth + 1));
      }
      return leaf(value);
    }
    if (Array.isArray(value))
      return value.map((item) => scrub(item, depth + 1));
    if (value && typeof value === "object") {
      const entries: Array<[string, unknown]> = [],
        seen = new Set<string>();
      for (const [key, item] of Object.entries(value)) {
        const privateKey = PRIVATE_KEY.test(
          key.toLowerCase().replace(/[_-]/g, "")
        );
        const name = leaf(key);
        if (seen.has(name)) return withhold();
        seen.add(name);
        entries.push([name, privateKey ? REDACTED : scrub(item, depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  };
  const finish = (value: unknown, available: number): unknown => {
    if (
      jsonBytes(value, Math.min(budget, available)) >
      Math.min(budget, available)
    )
      return withhold();
    return scan(JSON.stringify(value)) ? withhold() : value;
  };
  const enterEscapedPhase = (): void => {
    if (escapedPhase) invalid();
    escapedPhase = true;
    for (const pattern of patterns) {
      pattern.text = pattern.escapedLength
        ? JSON.stringify(pattern.raw).slice(1, -1)
        : "";
      pattern.ready = false;
    }
    // FIRST escaped check: no escaped fallback is permitted before this preflight.
    if (scan(SERIALIZED_REDACTED)) invalid();
  };
  return { scrub, finish, enterEscapedPhase };
}

// Selection and raw byte budgeting happen before any content scrubbing. Every authorized row
// stays in the native page: oversized optional fields become null; core identity cannot be dropped.
function projectObservation(
  row: Readonly<Record<string, unknown>>,
  fields: string,
  rawByteBudget: number,
  onTruncated: () => void
): Record<string, unknown> {
  const allowed = new Set(
    ["core", ...fields.split(",")].flatMap((g) => FIELD_GROUPS[g] ?? [])
  );
  const result: Record<string, unknown> = {};
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
  for (const key of allowed) {
    if (!(key in row)) continue;
    if (key === "metadata") {
      result.metadata =
        row.metadata &&
        typeof row.metadata === "object" &&
        !Array.isArray(row.metadata)
          ? Object.fromEntries(
              Object.entries(metadata)
                .filter(([k]) => METADATA_KEYS.has(k))
                .map(([k, v]) => [
                  k,
                  typeof v === "string" ||
                  typeof v === "number" ||
                  typeof v === "boolean"
                    ? k === "nodeId" || /Id$/.test(k)
                      ? typeof v === "string" &&
                        v.length <= 256 &&
                        /^[a-zA-Z0-9:_.-]+$/.test(v)
                        ? v
                        : null
                      : v
                    : null,
                ])
            )
          : null;
    } else if (key === "usageDetails" || key === "costDetails") {
      const value = row[key];
      result[key] =
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).filter(
                ([, v]) => typeof v === "number" && Number.isFinite(v)
              )
            )
          : null;
    } else result[key] = row[key];
  }
  if (!fields.split(",").includes("model")) {
    for (const field of ["modelId", "inputPrice", "outputPrice", "totalPrice"])
      result[field] = null;
  }

  // rowBudget * requested limit is <=1MiB (less metadata/cursor headroom). Counting the selected
  // raw fields prevents redaction-shrunk output from multiplying regex work across fields/rows.
  let selectedBytes = jsonBytes(result, Number.MAX_SAFE_INTEGER);
  if (selectedBytes > rawByteBudget) {
    const identity = new Set([
      "id",
      "traceId",
      "startTime",
      "endTime",
      "projectId",
      "parentObservationId",
      "type",
    ]);
    const optional = Object.entries(result)
      .filter(([key]) => !identity.has(key))
      .map(([key, value]) => ({
        key,
        bytes: jsonBytes(value, Number.MAX_SAFE_INTEGER),
      }))
      .sort((a, b) => b.bytes - a.bytes);
    for (const field of optional) {
      if (selectedBytes <= rawByteBudget) break;
      if (field.bytes <= 4) continue;
      result[field.key] = null;
      selectedBytes -= field.bytes - 4;
      onTruncated();
    }
    if (selectedBytes > rawByteBudget)
      throw new LangfuseReadError("observability_response_too_large", 502);
  }

  const privateValues = [
    "user_api_key_hash",
    "user_api_key",
    "billingAccountId",
    "user_api_key_end_user_id",
    "user_api_key_user_email",
  ]
    .map((key) => metadata[key])
    .filter(
      (value): value is string => typeof value === "string" && value.length >= 8
    );
  const policy = contentPolicy(privateValues, rawByteBudget, onTruncated);
  const targets: Array<{ object: Record<string, unknown>; key: string }> = [];
  for (const key of [
    "input",
    "output",
    "modelParameters",
    "statusMessage",
    "tags",
  ]) {
    if (key in result) targets.push({ object: result, key });
  }
  if (result.metadata && typeof result.metadata === "object") {
    const selectedMetadata = result.metadata as Record<string, unknown>;
    for (const key of Object.keys(selectedMetadata)) {
      if (key !== "nodeId" && !/Id$/.test(key))
        targets.push({ object: selectedMetadata, key });
    }
  }
  // All recursive decoding and RAW serialization checks finish before any prefix is overwritten.
  for (const { object, key } of targets)
    object[key] = policy.scrub(object[key]);
  for (const { object, key } of targets) {
    const otherBytes =
      jsonBytes(result, Number.MAX_SAFE_INTEGER) -
      jsonBytes(object[key], Number.MAX_SAFE_INTEGER);
    object[key] = policy.finish(object[key], rawByteBudget - otherBytes);
  }
  policy.enterEscapedPhase();
  for (const { object, key } of targets) {
    const otherBytes =
      jsonBytes(result, Number.MAX_SAFE_INTEGER) -
      jsonBytes(object[key], Number.MAX_SAFE_INTEGER);
    object[key] = policy.finish(object[key], rawByteBudget - otherBytes);
  }
  return result;
}
