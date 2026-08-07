// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/langfuse-reader`
 * Purpose: Port for reading a single node's Langfuse AI traces on a dev's behalf. The operator pod
 *   holds the Langfuse key (it creates the traces); the dev never does. Used only by the observability
 *   trace-read proxy routes after the per-node RBAC check, pinned server-side to `tags=<nodeId>`.
 * Scope: Interface + row type only. The HTTP adapter lives in adapters/server; wiring in bootstrap.
 * Invariants:
 *   - READ_ONLY (Langfuse public GET /traces only)
 *   - KEY_NEVER_LOGGED (the adapter must not log the secret key)
 *   - NODE_PIN_IS_FORCED (the `tags=<nodeId>` filter is set by the route, not the caller)
 * Side-effects: none (interface)
 * Links: src/adapters/server/observability/langfuse-reader.adapter.ts, src/bootstrap/observability.factory.ts, docs/spec/substrate-access-grant.md
 * @public
 */

export type LangfuseJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly LangfuseJsonValue[]
  | { readonly [key: string]: LangfuseJsonValue };

/** One Langfuse trace, projected to the node-attributable fields a dev needs to debug. */
export interface LangfuseTraceSummary {
  readonly id: string;
  readonly name: string | null;
  /** ISO timestamp of trace creation. */
  readonly timestamp: string;
  /** Low-cardinality tags, including the pinned `nodeId` (LANGFUSE_NODE_ATTRIBUTION). */
  readonly tags: readonly string[];
  /** Resolved from trace metadata; the per-node read filter. */
  readonly nodeId: string | null;
}

/** One node-bound Langfuse trace detail, with content fields returned only after node-boundary proof. */
export interface LangfuseTraceDetail extends LangfuseTraceSummary {
  readonly metadata: LangfuseJsonValue | null;
  readonly input: LangfuseJsonValue | null;
  readonly output: LangfuseJsonValue | null;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly release: string | null;
  readonly version: string | null;
}

export interface LangfuseTraceQuery {
  /** The node the read is pinned to — set by the route from the resolved node, never the caller. */
  readonly nodeId: string;
  readonly limit: number;
  /** Optional Langfuse `environment` narrowing filter (e.g. "candidate-a"). */
  readonly environment?: string;
}

export interface LangfuseTraceDetailQuery {
  /** The node the read is pinned to — set by the route from the resolved node, never the caller. */
  readonly nodeId: string;
  readonly traceId: string;
}

export interface LangfuseReaderPort {
  /**
   * List this node's traces (newest-first), pinned to `tags=<nodeId>`.
   * Throws on transport/HTTP error.
   */
  listTraces(query: LangfuseTraceQuery): Promise<LangfuseTraceSummary[]>;

  /**
   * Get one trace detail after proving it belongs to `nodeId` via tags and/or metadata.nodeId.
   * Returns null for upstream 404 or node-boundary mismatch/missing attribution.
   * Throws on other transport/HTTP errors.
   */
  getTrace(
    query: LangfuseTraceDetailQuery
  ): Promise<LangfuseTraceDetail | null>;
}
