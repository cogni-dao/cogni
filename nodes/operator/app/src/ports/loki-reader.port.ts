// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/loki-reader`
 * Purpose: Port for running a (node-pinned) LogQL query against Grafana Cloud Loki on a dev's behalf.
 *   The operator holds the read token; the dev never does. Used only by the observability log-read
 *   proxy route after the per-node RBAC check + node-pin (see `@features/nodes/observability-logs`).
 * Scope: Interface + row type only. The HTTP adapter lives in adapters/server; wiring in bootstrap.
 * Invariants: READ_ONLY (query_range only); TOKEN_NEVER_LOGGED (the adapter must not log the token).
 * Side-effects: none (interface)
 * Links: src/adapters/server/observability/loki-reader.adapter.ts, src/bootstrap/observability.factory.ts
 * @public
 */

export interface LokiLogLine {
  /** Nanosecond epoch timestamp as returned by Loki (string to avoid precision loss). */
  readonly ts: string;
  /** The raw log line. */
  readonly line: string;
}

export interface LokiQueryRange {
  readonly query: string;
  readonly startNs: string;
  readonly endNs: string;
  readonly limit: number;
  /** Optional caller abort (a metric calculator's budget). The adapter's own timeout still applies. */
  readonly signal?: AbortSignal;
}

/** One sample of an instant metric query (a LogQL `sum(count_over_time(...))` vector element). */
export interface LokiVectorSample {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface LokiInstantQuery {
  /** A LogQL metric query, for example `sum(count_over_time({...} |= "x" [3600s]))`. */
  readonly query: string;
  /** Evaluation instant, nanosecond epoch as a string. */
  readonly atNs: string;
  readonly signal?: AbortSignal;
}

/**
 * Instant metric queries: a count over a window with no line cap (a `query_range` read returns at most `limit`
 * lines). Same Grafana datasource proxy and read token as `LokiReaderPort`; the same adapter implements both.
 */
export interface LokiInstantReaderPort {
  /** Run a Loki instant query and return the vector. An empty vector is a result (nothing matched). Throws on error. */
  queryInstant(input: LokiInstantQuery): Promise<readonly LokiVectorSample[]>;
}

export interface LokiReaderPort {
  /** Run a Loki `query_range` and return newest-first lines. Throws on transport/HTTP error. */
  queryRange(range: LokiQueryRange): Promise<LokiLogLine[]>;
}
