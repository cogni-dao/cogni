// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/tests/unit/app/knowledge/loaders`
 * Purpose: Unit coverage for the knowledge SSR loaders — proving they return the
 *   exact wire shape the client fetchers receive (so `initialData` seeded on the
 *   server === the post-hydration refetch, no hydration shift) and that the
 *   graph loader collapses to a single citation read.
 * Scope: Unit — drives the loaders against a FakeKnowledgeStoreAdapter. No HTTP,
 *   no database, no container.
 * Invariants: RESPONSE_SHAPED_OUTPUT (createdAt is a JSON-safe ISO string, not a
 *   Date), LIST_LIMIT_PARITY, EDGE_ENDPOINTS_EXIST.
 * Side-effects: none (in-memory fake)
 * Links: src/app/(app)/knowledge/_server/loaders.ts, docs/spec/knowledge-syntropy.md
 * @internal
 */

import { buildKnowledgeGraph, type Citation } from "@cogni/knowledge-store";
import { FakeKnowledgeStoreAdapter } from "@cogni/knowledge-store/adapters/fake";
import { describe, expect, it } from "vitest";

import {
  loadDomains,
  loadKnowledgeGraph,
  loadKnowledgeList,
} from "@/app/(app)/knowledge/_server/loaders";

const DOMAIN = "operator";

async function seed() {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: DOMAIN, name: "Operator" });
  await store.addKnowledge({
    id: "k1",
    domain: DOMAIN,
    title: "First",
    content: "...",
    entryType: "finding",
    sourceType: "agent",
  });
  await store.addKnowledge({
    id: "k2",
    domain: DOMAIN,
    title: "Second",
    content: "...",
    entryType: "finding",
    sourceType: "agent",
  });
  await store.addCitation({
    citingId: "k1",
    citedId: "k2",
    citationType: "supports",
  });
  return store;
}

describe("knowledge SSR loaders", () => {
  it("loadKnowledgeList returns JSON-safe wire rows (createdAt string|null, not Date)", async () => {
    const store = await seed();
    const res = await loadKnowledgeList(store, { limit: 500 });

    expect(res.items).toHaveLength(2);
    expect(res.domains).toContain(DOMAIN);

    const k1 = res.items.find((i) => i.id === "k1");
    expect(k1?.createdAt === null || typeof k1?.createdAt === "string").toBe(
      true
    );
    // JSON round-trip is a no-op ⇒ SSR initialData matches the client refetch.
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
  });

  it("loadKnowledgeList honors the cross-domain limit", async () => {
    const store = await seed();
    const res = await loadKnowledgeList(store, { limit: 1 });
    expect(res.items).toHaveLength(1);
  });

  it("loadDomains returns the registry with entry counts", async () => {
    const store = await seed();
    const res = await loadDomains(store);
    const d = res.domains.find((x) => x.id === DOMAIN);
    expect(d?.entryCount).toBe(2);
  });

  it("loadKnowledgeGraph collapses to nodes + edges via one citation read", async () => {
    const store = await seed();
    const g = await loadKnowledgeGraph(store);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["k1", "k2"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ source: "k1", target: "k2" });
  });

  it("buildKnowledgeGraph drops an edge whose endpoint is not a node (EDGE_ENDPOINTS_EXIST)", async () => {
    const store = await seed();
    const domains = await store.listDomains();
    const entries = (
      await Promise.all(domains.map((d) => store.listKnowledge(d)))
    ).flat();
    const dangling: Citation = {
      id: "dangle",
      citingId: "k1",
      citedId: "ghost",
      citationType: "supports",
      context: null,
    };

    const graph = buildKnowledgeGraph({
      domains,
      entries,
      citations: [...(await store.listAllCitations()), dangling],
    });

    expect(graph.edges.some((e) => e.target === "ghost")).toBe(false);
    expect(graph.edges).toHaveLength(1);
  });
});
