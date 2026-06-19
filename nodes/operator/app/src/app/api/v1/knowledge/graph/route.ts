// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/graph/route`
 * Purpose: GET /api/v1/knowledge/graph — full node (entry) + edge (citation) set
 *   for the 3D knowledge graph view. Reads every domain's entries plus each
 *   entry's outgoing citations via container.knowledgeStorePort.
 * Scope: Cookie-session only (Bearer agents rejected 403, like /knowledge).
 *   Edges gathered from per-node outgoing citations — every citation has exactly
 *   one citing node in the set, so this yields the complete edge list.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_BROWSE_VIA_HTTP_REQUIRES_SESSION,
 *   EDGE_ENDPOINTS_EXIST (edges whose cited target isn't in the node set are dropped).
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Graph contract lives in-node (not @cogni/node-contracts) to keep this PR
// single-node-scoped. The client mirrors this shape in `_api/fetchGraph.ts`.
const GraphNodeSchema = z.object({
  id: z.string(),
  domain: z.string(),
  title: z.string(),
  entryType: z.string(),
  confidencePct: z.number().int().nullable(),
  sourceType: z.string(),
});
const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  citationType: z.string(),
});
const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  domains: z.array(z.string()),
});

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.graph",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Mirror /api/v1/knowledge: Bearer agents must not browse the knowledge
    // plane in v0 (KNOWLEDGE_BROWSE_VIA_HTTP_REQUIRES_SESSION).
    const authz = request.headers.get("authorization") ?? "";
    if (authz.toLowerCase().startsWith("bearer ")) {
      return NextResponse.json(
        { error: "knowledge graph requires a session cookie (v0)" },
        { status: 403 }
      );
    }

    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    const domains = await port.listDomains();
    const nodes: z.infer<typeof GraphNodeSchema>[] = [];
    const nodeIds = new Set<string>();
    const entryIds: string[] = [];
    for (const domain of domains) {
      const rows = await port.listKnowledge(domain, { limit: 10_000 });
      for (const r of rows) {
        nodeIds.add(r.id);
        entryIds.push(r.id);
        nodes.push({
          id: r.id,
          domain: r.domain,
          title: r.title,
          entryType: r.entryType ?? "finding",
          confidencePct: r.confidencePct ?? null,
          sourceType: r.sourceType,
        });
      }
    }

    // Every citation has exactly one citing node (which is in our set), so
    // gathering each node's outgoing edges yields the full edge list. Drop
    // edges whose cited target isn't a node (deprecated/cross-domain dangling
    // refs) so the client never renders a floating edge.
    const edgeLists = await Promise.all(
      entryIds.map((id) => port.listCitationsByCitingId(id))
    );
    const edges: z.infer<typeof GraphEdgeSchema>[] = [];
    for (const list of edgeLists) {
      for (const c of list) {
        if (!nodeIds.has(c.citedId)) continue;
        edges.push({
          id: c.id,
          source: c.citingId,
          target: c.citedId,
          citationType: c.citationType,
        });
      }
    }

    ctx.log.info(
      { nodes: nodes.length, edges: edges.length, domains: domains.length },
      "knowledge.graph_success"
    );

    return NextResponse.json(
      GraphResponseSchema.parse({ nodes, edges, domains })
    );
  }
);
