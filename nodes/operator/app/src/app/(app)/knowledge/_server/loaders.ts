// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_server/loaders`
 * Purpose: Server-side data loaders for the knowledge dashboard. ONE source of
 *   truth for shape + query logic, called by BOTH the HTTP route handlers
 *   (/api/v1/knowledge, /graph, /domains) and the server `page.tsx` that seeds
 *   React Query `initialData`. Reading here (not via a self-HTTP fetch) is the
 *   house SSR idiom (see `(app)/nodes/page.tsx`) — no cookie forwarding needed.
 * Scope: Server only. Takes an injected KnowledgeStorePort; no env, no lifecycle.
 * Invariants:
 *   - RESPONSE_SHAPED_OUTPUT: returns zod-validated, wire-serialized objects
 *     (createdAt ISO strings) IDENTICAL to what the client fetchers receive, so
 *     SSR initialData === post-hydration refetch (no hydration shift).
 *   - PARALLEL_FANOUT: per-domain reads run concurrently (Promise.all), not the
 *     legacy serial `for … await` loop.
 *   - LIST_LIMIT_PARITY: caller passes the same params the client fetcher uses
 *     (the browse UI fetches `?limit=500`).
 * Side-effects: IO (Doltgres reads via the injected port)
 * Links: docs/spec/knowledge-syntropy.md
 * @internal
 */

import {
  buildKnowledgeGraph,
  type KnowledgeGraphModel,
  type KnowledgeStorePort,
} from "@cogni/knowledge-store";
import {
  type DomainsListResponse,
  DomainsListResponseSchema,
  type KnowledgeListResponse,
  KnowledgeListResponseSchema,
  type KnowledgeRow,
} from "@cogni/node-contracts";

export interface KnowledgeListOpts {
  domain?: string | undefined;
  sourceType?: string | undefined;
  limit?: number | undefined;
}

/**
 * Browse list across all (or one) domain. Mirrors GET /api/v1/knowledge exactly:
 * same field mapping, same cross-domain `limit` cutoff, same `domains` payload —
 * only the per-domain reads are parallelized.
 */
export async function loadKnowledgeList(
  port: KnowledgeStorePort,
  opts: KnowledgeListOpts = {}
): Promise<KnowledgeListResponse> {
  const allDomains = await port.listDomains();
  const targetDomains = opts.domain
    ? allDomains.filter((d) => d === opts.domain)
    : allDomains;

  const perDomain = await Promise.all(
    targetDomains.map((d) =>
      port.listKnowledge(d, opts.limit != null ? { limit: opts.limit } : {})
    )
  );

  const items: KnowledgeRow[] = [];
  for (const rows of perDomain) {
    for (const r of rows) {
      if (opts.sourceType && r.sourceType !== opts.sourceType) continue;
      items.push({
        id: r.id,
        domain: r.domain,
        entityId: r.entityId ?? null,
        title: r.title,
        content: r.content,
        entryType: r.entryType ?? "finding",
        confidencePct: r.confidencePct ?? null,
        sourceType: r.sourceType,
        sourceRef: r.sourceRef ?? null,
        tags: r.tags ?? null,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      });
      if (opts.limit != null && items.length >= opts.limit) break;
    }
    if (opts.limit != null && items.length >= opts.limit) break;
  }

  return KnowledgeListResponseSchema.parse({ items, domains: allDomains });
}

/** Registered domains + entry counts. Mirrors GET /api/v1/knowledge/domains. */
export async function loadDomains(
  port: KnowledgeStorePort
): Promise<DomainsListResponse> {
  const domains = await port.listDomainsFull();
  return DomainsListResponseSchema.parse({ domains });
}

/**
 * Full graph model. Mirrors GET /api/v1/knowledge/graph but collapses the
 * legacy per-entry citation N+1 into a single `listAllCitations()` read, then
 * assembles nodes/edges via the shared `buildKnowledgeGraph`.
 */
export async function loadKnowledgeGraph(
  port: KnowledgeStorePort
): Promise<KnowledgeGraphModel> {
  const domains = await port.listDomains();
  const perDomain = await Promise.all(
    domains.map((d) => port.listKnowledge(d, { limit: 10_000 }))
  );
  const entries = perDomain.flat();
  const citations = await port.listAllCitations();
  return buildKnowledgeGraph({ domains, entries, citations });
}
