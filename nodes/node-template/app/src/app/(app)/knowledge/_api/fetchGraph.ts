// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchGraph`
 * Purpose: Client-side fetch wrapper + wire types for the knowledge graph
 *   (nodes + citation edges). Types mirror the in-node route schema at
 *   GET /api/v1/knowledge/graph (kept in-node, not @cogni/node-contracts, so
 *   the graph feature stays single-node-scoped).
 * Scope: Calls GET /api/v1/knowledge/graph with same-origin credentials.
 * Invariants: Cookie-session only — never sends a Bearer header (per KNOWLEDGE_BROWSE_VIA_HTTP_REQUIRES_SESSION).
 * Side-effects: IO
 * @internal
 */

export interface KnowledgeGraphNode {
  id: string;
  domain: string;
  title: string;
  entryType: string;
  confidencePct: number | null;
  sourceType: string;
}

export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  citationType: string;
}

export interface KnowledgeGraphResponse {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  domains: string[];
}

export async function fetchGraph(): Promise<KnowledgeGraphResponse> {
  const response = await fetch("/api/v1/knowledge/graph", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch knowledge graph",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<KnowledgeGraphResponse>;
}
