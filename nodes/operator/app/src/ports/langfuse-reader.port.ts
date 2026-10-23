// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/langfuse-reader`
 * Purpose: Node-scoped native Langfuse observation reads and compatibility summaries.
 * Scope: Interfaces only; backend ownership verification is an independent read port.
 * Invariants: Native rows need trusted per-observation evidence, never names/tags alone;
 *   shared backend credentials remain server-side and paging is bound to node/lane/query.
 * Side-effects: none (interface)
 * Links: src/adapters/server/observability/langfuse-reader.adapter.ts, src/bootstrap/observability.factory.ts, docs/spec/substrate-access-grant.md
 * @public
 */

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

export interface LangfuseTraceQuery {
  /** The node the read is pinned to — set by the route from the resolved node, never the caller. */
  readonly nodeId: string;
  readonly limit: number;
  /** Optional Langfuse `environment` narrowing filter (e.g. "candidate-a"). */
  readonly environment?: string;
}

/** Native read boundary. Records are validated against the HTTP contract before delivery. */
export interface LangfuseObservationQuery {
  readonly nodeId: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly limit: number;
  readonly fields: string;
  readonly filters: readonly {
    readonly type: "string";
    readonly column: string;
    readonly operator: "=";
    readonly value: string;
  }[];
  readonly fromStartTime?: string;
  readonly toStartTime?: string;
  readonly cursor?: string;
}
export interface LangfuseObservationPage {
  readonly data: readonly Record<string, unknown>[];
  readonly meta: {
    readonly cursor: string | null;
    readonly cogni: {
      readonly contractVersion: "langfuse-observations-v2.1";
      readonly nodeId: string;
      readonly logicalEnvironment: "candidate-a" | "preview" | "production";
      readonly fromStartTime: string;
      readonly toStartTime: string;
      readonly partial: boolean;
      readonly attributionUnavailable: number;
      readonly privacyProjected: true;
      readonly truncated: boolean;
    };
  };
}
/** Independently trusted routing/call evidence, never caller metadata or names alone. */
export interface LangfuseOwnershipPort {
  verifyObservation(
    nodeId: string,
    environment: string,
    observation: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<boolean>;
}
export interface LangfuseReaderPort {
  listObservations(
    query: LangfuseObservationQuery
  ): Promise<LangfuseObservationPage>;

  /**
   * List this node's traces (newest-first), pinned to `tags=<nodeId>`.
   * Throws on transport/HTTP error.
   */
  listTraces(query: LangfuseTraceQuery): Promise<LangfuseTraceSummary[]>;
}
