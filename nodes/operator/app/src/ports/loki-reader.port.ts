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
}

export interface LokiReaderPort {
  /** Run a Loki `query_range` and return newest-first lines. Throws on transport/HTTP error. */
  queryRange(range: LokiQueryRange): Promise<LokiLogLine[]>;
}
