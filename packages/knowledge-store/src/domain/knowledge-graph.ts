// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/knowledge-graph`
 * Purpose: Assemble the knowledge-graph view model (entry nodes + citation edges) from raw port reads, as one shared pure function every node reuses.
 * Scope: Pure function + view-model types. Does not perform I/O, read env, or import a framework — the caller supplies entries + citations from the port.
 * Invariants:
 *   - EDGE_ENDPOINTS_EXIST: an edge is kept only when BOTH endpoints are entry
 *     nodes in the set. Drops work-item `tracks` edges and dangling refs so the
 *     client never renders a floating edge. This matches the legacy per-entry
 *     outgoing-citation gather (source was always an entry; target was checked).
 * Side-effects: none
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import type { Citation } from "./schemas.js";

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

export interface KnowledgeGraphModel {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  domains: string[];
}

/**
 * Build the graph view model. `nodes` is the projected entry set (id, domain,
 * title, entryType, confidencePct, sourceType — never `content`; one projected
 * read, see `KnowledgeStorePort.listKnowledgeGraphNodes`). `citations` is the
 * full edge set (one query); edges are filtered to those whose citing AND cited
 * endpoints are both nodes in the set, yielding the exact edge list the legacy
 * N+1-per-entry gather produced.
 */
export function buildKnowledgeGraph(input: {
  domains: string[];
  nodes: readonly KnowledgeGraphNode[];
  citations: readonly Citation[];
}): KnowledgeGraphModel {
  const { domains, nodes: inputNodes, citations } = input;

  const nodeIds = new Set<string>();
  const nodes: KnowledgeGraphNode[] = [];
  for (const n of inputNodes) {
    nodeIds.add(n.id);
    nodes.push({
      id: n.id,
      domain: n.domain,
      title: n.title,
      entryType: n.entryType,
      confidencePct: n.confidencePct,
      sourceType: n.sourceType,
    });
  }

  const edges: KnowledgeGraphEdge[] = [];
  for (const c of citations) {
    if (!nodeIds.has(c.citingId) || !nodeIds.has(c.citedId)) continue;
    edges.push({
      id: c.id,
      source: c.citingId,
      target: c.citedId,
      citationType: c.citationType,
    });
  }

  return { nodes, edges, domains };
}
