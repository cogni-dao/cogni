// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/loki-reader.adapter`
 * Purpose: HTTP adapter for `LokiReaderPort` — runs a Loki `query_range` or instant `query` against the Grafana Cloud
 *   datasource-proxy with the operator's read token (same shape as `scripts/loki-query.sh`).
 * Scope: IO only. Credentials/URL are constructor inputs (no env loading here — bootstrap wires them).
 * Invariants: READ_ONLY (query_range, query); TOKEN_NEVER_LOGGED (no token in errors/logs).
 * Side-effects: network (fetch to Grafana Cloud)
 * Links: src/ports/loki-reader.port.ts, src/bootstrap/observability.factory.ts
 * @public
 */

import type {
  LokiInstantQuery,
  LokiInstantSample,
  LokiLogLine,
  LokiQueryRange,
  LokiReaderPort,
} from "@/ports";

export class HttpLokiReader implements LokiReaderPort {
  private readonly base: string;
  private readonly token: string;
  private readonly datasourceUid: string;

  constructor(opts: {
    grafanaUrl: string;
    token: string;
    datasourceUid?: string;
  }) {
    this.base = opts.grafanaUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.datasourceUid = opts.datasourceUid ?? "grafanacloud-logs";
  }

  async queryRange(range: LokiQueryRange): Promise<LokiLogLine[]> {
    const url = new URL(
      `${this.base}/api/datasources/proxy/uid/${this.datasourceUid}/loki/api/v1/query_range`
    );
    url.searchParams.set("query", range.query);
    url.searchParams.set("start", range.startNs);
    url.searchParams.set("end", range.endNs);
    url.searchParams.set("limit", String(range.limit));
    url.searchParams.set("direction", "backward");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      // Loki reads are fast; bound the call so a hung upstream can't pin the route.
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      // Never echo the token; include status + a short body excerpt for diagnosis.
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`loki query_range failed: HTTP ${res.status} ${body}`);
    }

    const json = (await res.json()) as LokiQueryRangeResponse;
    const streams = json.data?.result ?? [];
    const lines: LokiLogLine[] = [];
    for (const stream of streams) {
      for (const [ts, line] of stream.values ?? []) {
        lines.push({ ts, line });
      }
    }
    // Newest-first, then cap (Loki caps per-stream, not across the merged set).
    lines.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return lines.slice(0, range.limit);
  }

  async queryInstant(input: LokiInstantQuery): Promise<LokiInstantSample[]> {
    const url = new URL(
      `${this.base}/api/datasources/proxy/uid/${this.datasourceUid}/loki/api/v1/query`
    );
    url.searchParams.set("query", input.query);
    if (input.timeNs) url.searchParams.set("time", input.timeNs);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`loki query failed: HTTP ${res.status} ${body}`);
    }

    const json = (await res.json()) as LokiInstantResponse;
    if (json.data?.resultType !== "vector") {
      throw new Error(
        `loki query returned ${json.data?.resultType ?? "no"} result, expected vector`
      );
    }
    const out: LokiInstantSample[] = [];
    for (const r of json.data.result ?? []) {
      const value = Number(r.value?.[1]);
      if (!Number.isFinite(value)) continue;
      out.push({ labels: r.metric ?? {}, value });
    }
    return out;
  }
}

interface LokiInstantResponse {
  readonly data?: {
    readonly resultType?: string;
    readonly result?: ReadonlyArray<{
      readonly metric?: Record<string, string>;
      readonly value?: readonly [number, string];
    }>;
  };
}

interface LokiQueryRangeResponse {
  readonly data?: {
    readonly result?: ReadonlyArray<{
      readonly values?: ReadonlyArray<readonly [string, string]>;
    }>;
  };
}
