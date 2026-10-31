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
import { toKnowledgeRow } from "@cogni/shared-knowledge-store";
import { unstable_cache } from "next/cache";

export interface KnowledgeListOpts {
  domain?: string | undefined;
  sourceType?: string | undefined;
  limit?: number | undefined;
  /** Include EDO rows (chains mode). Default: excluded. */
  includeEdo?: boolean | undefined;
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
      port.listKnowledge(d, {
        ...(opts.limit != null ? { limit: opts.limit } : {}),
        ...(opts.includeEdo ? { includeEdo: true } : {}),
      })
    )
  );

  const items: KnowledgeRow[] = [];
  for (const rows of perDomain) {
    for (const r of rows) {
      if (opts.sourceType && r.sourceType !== opts.sourceType) continue;
      items.push(toKnowledgeRow(r));
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
  // ONE projected read of all entries (6 graph columns, never `content`) +
  // one citation read. Memory is bounded by node/edge count, not body bytes —
  // the old `limit:10_000` per-domain full-body read materialized ~168 bodies
  // the graph discards, the heap-OOM driver (bug.5547).
  const [domains, nodes, citations] = await Promise.all([
    port.listDomains(),
    port.listKnowledgeGraphNodes(),
    port.listAllCitations(),
  ]);
  return buildKnowledgeGraph({ domains, nodes, citations });
}

/**
 * Revision-keyed SSR cache (bug.5547). `force-dynamic` stays for the per-request
 * auth check; only the store READ is cached, keyed by the Dolt head commit
 * (`currentCommit()`) so repeat `/knowledge` refreshes are cache hits — zero
 * body re-reads — while a contribution merge (which moves the head commit)
 * busts the cache the same request, with no stale window. One cheap
 * `dolt_hashof('HEAD')` read per request computes the key.
 *
 * Scoped to the SSR page (the OOM source); the `/api/v1/knowledge*` routes keep
 * the raw loaders, so their response freshness is unchanged.
 */
const KNOWLEDGE_CACHE_TAG = "knowledge";

export async function loadKnowledgeListCached(
  port: KnowledgeStorePort,
  opts: KnowledgeListOpts = {}
): Promise<KnowledgeListResponse> {
  const rev = await port.currentCommit();
  return unstable_cache(
    () => loadKnowledgeList(port, opts),
    ["knowledge-list", rev, JSON.stringify(opts)],
    { tags: [KNOWLEDGE_CACHE_TAG] }
  )();
}

export async function loadKnowledgeGraphCached(
  port: KnowledgeStorePort
): Promise<KnowledgeGraphModel> {
  const rev = await port.currentCommit();
  return unstable_cache(
    () => loadKnowledgeGraph(port),
    ["knowledge-graph", rev],
    {
      tags: [KNOWLEDGE_CACHE_TAG],
    }
  )();
}
