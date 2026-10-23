// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/langfuse-reader.adapter`
 * Purpose: Bounded native v2 observation reads with independently verified node ownership,
 *   scoped signed cursors and privacy projection; retains the legacy trace-summary reader.
 * Scope: IO only. Credentials/URL are constructor inputs (no env loading here — bootstrap wires them).
 * Invariants: READ_ONLY; independently verified observation ownership; no credential-bearing errors.
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
  private readonly operatorNodeId: string | undefined;

  constructor(opts: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
    ownership?: LangfuseOwnershipPort;
    operatorNodeId?: string;
  }) {
    this.cursorKey = createHash("sha256")
      .update(`langfuse-reader-cursor-v1:${opts.secretKey}`)
      .digest();
    this.ownership = opts.ownership;
    this.operatorNodeId = opts.operatorNodeId;
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
    if (!this.ownership)
      throw new LangfuseReadError("attribution_unavailable", 503);
    const { cursor, ...scopeQuery } = query;
    const scope = createHash("sha256")
      .update(JSON.stringify({ base: this.base, ...scopeQuery }))
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
    // Metadata key aliases are only candidate selectors; independently trusted receipts decide reach.
    const ownershipFilter =
      query.nodeId === this.operatorNodeId
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
      {
        type: "string",
        column: "environment",
        operator: "=",
        value: "production",
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
    url.searchParams.set("limit", String(query.limit));
    url.searchParams.set("parseIoAsJson", "false");
    if (upstreamCursor) url.searchParams.set("cursor", upstreamCursor);
    const res = await fetch(url, {
      headers: { Authorization: this.authHeader },
      signal,
      redirect: "error",
    }).catch((error: unknown) => {
      throw safeDependencyFailure(error, signal);
    });
    if (!res.ok) {
      // Upstream bodies can contain credential-bearing metadata; never read/echo them in errors.
      await res.body?.cancel();
      throw new LangfuseReadError(
        res.status === 429
          ? "observability_rate_limited"
          : "observability_upstream_error",
        res.status === 429 ? 429 : 502,
        safeRetryAfter(res.headers.get("retry-after"))
      );
    }
    const page = NativePageSchema.parse(
      JSON.parse(
        await readBounded(res, 8 * 1024 * 1024).catch((error: unknown) => {
          throw safeDependencyFailure(error, signal);
        })
      )
    );
    if (page.data.length > query.limit)
      throw new LangfuseReadError("observability_invalid_response", 502);
    const data: Record<string, unknown>[] = [];
    let unavailable = 0;
    let truncated = false;
    // Allocate each row a fair share of the response budget, leaving meta/cursor headroom.
    const rowBudget = Math.floor((1024 * 1024 - 32768) / query.limit);
    for (const row of page.data) {
      const time = Date.parse(String(row.startTime));
      if (
        !Number.isFinite(time) ||
        time < Date.parse(from) ||
        time >= Date.parse(to) ||
        row.environment !== "production" ||
        !matchesFilters(row, query.filters) ||
        !(await this.ownership.verifyObservation(
          query.nodeId,
          query.environment,
          row,
          signal
        ))
      ) {
        unavailable++;
        continue;
      }
      const bounded = { ...row };
      for (const field of ["input", "output", "modelParameters"]) {
        if (
          field in bounded &&
          Buffer.byteLength(JSON.stringify(bounded[field]) ?? "") >
            rowBudget / 2
        ) {
          bounded[field] = null;
          truncated = true;
        }
      }
      const projected = projectObservation(bounded, query.fields);
      if (Buffer.byteLength(JSON.stringify(projected)) > rowBudget) {
        // Withhold over-budget content rather than corrupt a JSON/string payload or skip pagination rows.
        for (const field of ["input", "output", "modelParameters"]) {
          if (field in projected) projected[field] = null;
        }
        truncated = true;
      }
      if (Buffer.byteLength(JSON.stringify(projected)) > rowBudget) {
        throw new LangfuseReadError("observability_response_too_large", 502);
      }
      data.push(projected);
    }
    const next = page.meta.cursor
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
          partial: unavailable > 0 || truncated,
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
async function readBounded(response: Response, max: number): Promise<string> {
  if (!response.body)
    throw new LangfuseReadError("observability_invalid_response", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
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
function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[REDACTED]";
  if (typeof value === "string") {
    // Native v2 io is a string. Scrub encoded JSON recursively, then retain its string shape.
    if (/^[\s]*[[{]/.test(value)) {
      try {
        return JSON.stringify(scrubValue(JSON.parse(value), depth + 1));
      } catch {
        return "[REDACTED]";
      }
    }
    return scrubStringContent(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        PRIVATE_KEY.test(key.toLowerCase().replace(/[_-]/g, ""))
          ? "[REDACTED]"
          : scrubValue(v, depth + 1),
      ])
    );
  }
  return value;
}
function projectObservation(
  row: Readonly<Record<string, unknown>>,
  fields: string
): Record<string, unknown> {
  const allowed = new Set(
    ["core", ...fields.split(",")].flatMap((g) => FIELD_GROUPS[g] ?? [])
  );
  const result: Record<string, unknown> = {};
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
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
  const scrubContent = (value: unknown): unknown => {
    const cleaned = scrubValue(value);
    const serialized = JSON.stringify(cleaned);
    if (serialized === undefined) return cleaned;
    let safe = serialized;
    for (const secret of privateValues)
      safe = safe.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    return JSON.parse(safe) as unknown;
  };
  for (const key of allowed) {
    if (!(key in row)) continue;
    if (key === "metadata") {
      const m = row.metadata;
      result.metadata =
        m && typeof m === "object" && !Array.isArray(m)
          ? Object.fromEntries(
              Object.entries(m)
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
                      : scrubValue(v)
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
    } else {
      result[key] = [
        "input",
        "output",
        "modelParameters",
        "statusMessage",
        "tags",
      ].includes(key)
        ? scrubContent(row[key])
        : row[key];
    }
  }
  if (!fields.split(",").includes("model")) {
    for (const field of ["modelId", "inputPrice", "outputPrice", "totalPrice"])
      result[field] = null;
  }
  return result;
}
