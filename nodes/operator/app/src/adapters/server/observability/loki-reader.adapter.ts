// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/loki-reader.adapter`
 * Purpose: HTTP adapter for `LokiReaderPort` — runs a Loki `query_range` against the Grafana Cloud
 *   datasource-proxy with the operator's read token (same shape as `scripts/loki-query.sh`).
 * Scope: IO only. Credentials/URL are constructor inputs (no env loading here — bootstrap wires them).
 * Invariants: READ_ONLY (query_range); TOKEN_NEVER_LOGGED (no token in errors/logs).
 * Side-effects: network (fetch to Grafana Cloud)
 * Links: src/ports/loki-reader.port.ts, src/bootstrap/observability.factory.ts
 * @public
 */

import type {
  LokiInstantQuery,
  LokiInstantReaderPort,
  LokiLogLine,
  LokiQueryRange,
  LokiReaderPort,
  LokiVectorSample,
} from "@/ports";

export class HttpLokiReader implements LokiReaderPort, LokiInstantReaderPort {
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
      signal: range.signal
        ? AbortSignal.any([AbortSignal.timeout(15_000), range.signal])
        : AbortSignal.timeout(15_000),
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

  /** `GET /loki/api/v1/query`: one instant metric evaluation at `atNs`. Same proxy and token as `queryRange`. */
  async queryInstant(
    input: LokiInstantQuery
  ): Promise<readonly LokiVectorSample[]> {
    const url = new URL(
      `${this.base}/api/datasources/proxy/uid/${this.datasourceUid}/loki/api/v1/query`
    );
    url.searchParams.set("query", input.query);
    url.searchParams.set("time", input.atNs);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      // A 24 h count scans more than a line read; still bound the call.
      signal: input.signal
        ? AbortSignal.any([AbortSignal.timeout(30_000), input.signal])
        : AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`loki query failed: HTTP ${res.status} ${body}`);
    }

    const json = (await res.json()) as LokiInstantResponse;
    if (json.data?.resultType !== "vector")
      throw new Error("loki query: result is not a vector");
    return (json.data.result ?? []).map((r) => {
      const value = Number(r.value?.[1]);
      if (!Number.isFinite(value))
        throw new Error("loki query: sample value is not a number");
      return { labels: r.metric ?? {}, value };
    });
  }
}

interface LokiInstantResponse {
  readonly data?: {
    readonly resultType?: string;
    readonly result?: ReadonlyArray<{
      readonly metric?: Readonly<Record<string, string>>;
      readonly value?: readonly [number | string, string];
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
