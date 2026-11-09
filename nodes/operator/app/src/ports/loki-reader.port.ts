// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/loki-reader`
 * Purpose: Port for running a LogQL query against Grafana Cloud Loki. `queryRange` serves a dev's
 *   (node-pinned) log reads; `queryInstant` serves the operator's own metric queries (a vector of
 *   labelled numbers, e.g. `sum by (...) (count_over_time(...))`). The operator holds the read token;
 *   the dev never does. `queryRange` is used by the observability log-read proxy route after the
 *   per-node RBAC check + node-pin (see `@features/nodes/observability-logs`); `queryInstant` by the
 *   fleet AI-health goal calculator (`@features/ai-health/ai-kpis`, task.5468).
 * Scope: Interface + row type only. The HTTP adapter lives in adapters/server; wiring in bootstrap.
 * Invariants: READ_ONLY (query_range and query only); TOKEN_NEVER_LOGGED (the adapter must not log the token).
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
}

export interface LokiInstantQuery {
  readonly query: string;
  /** Evaluation time as nanosecond epoch; Loki uses "now" when absent. */
  readonly timeNs?: string;
}

/** One series of an instant metric query: its labels and its numeric value. */
export interface LokiInstantSample {
  readonly labels: Record<string, string>;
  readonly value: number;
}

export interface LokiReaderPort {
  /** Run a Loki `query_range` and return newest-first lines. Throws on transport/HTTP error. */
  queryRange(range: LokiQueryRange): Promise<LokiLogLine[]>;
  /** Run a Loki instant `query` (metric query) and return one sample per series. Throws on transport/HTTP error. */
  queryInstant(input: LokiInstantQuery): Promise<LokiInstantSample[]>;
}
