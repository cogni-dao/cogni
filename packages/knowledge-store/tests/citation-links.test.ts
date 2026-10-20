// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/citation-links`
 * Purpose: Prove bounded direct-edge reads and body-free endpoint projection.
 * Scope: Adapter unit contracts. Does not connect to a database or network.
 * Invariants: FIVE_LINKS_PER_PAGE, DIRECT_EDGES_ONLY, NO_BODY_READS_OR_N_PLUS_ONE.
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/issues/2832
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { DoltgresKnowledgeStoreAdapter } from "../src/adapters/doltgres/index.js";
import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";

describe("direct citation pages", () => {
  it("pages a high-degree root without visiting its neighbors' citations or bodies", async () => {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "meta", name: "Meta" });
    for (let i = 0; i < 14; i++) {
      await store.addKnowledge({
        id: `atom-${String(i).padStart(2, "0")}`,
        domain: "meta",
        title: `Atom ${i}`,
        content: "Large body ".repeat(1000),
        sourceType: "human",
      });
    }
    for (let i = 1; i <= 12; i++) {
      const neighbor = `atom-${String(i).padStart(2, "0")}`;
      await store.addCitation({
        citingId: i % 2 ? "atom-00" : neighbor,
        citedId: i % 2 ? neighbor : "atom-00",
        citationType: "supports",
      });
    }
    await store.addCitation({
      citingId: "atom-01",
      citedId: "atom-13",
      citationType: "supports",
    });
    const getBody = vi.spyOn(store, "getKnowledge");
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listCitationLinks("atom-00", cursor);
      expect(page.links.length).toBeLessThanOrEqual(5);
      for (const link of page.links) {
        expect([link.citingId, link.citedId]).toContain("atom-00");
        expect([link.citingId, link.citedId]).not.toContain("atom-13");
        expect(link).not.toHaveProperty("content");
        ids.push(link.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(getBody).not.toHaveBeenCalled();
  });

  it("uses one bounded metadata query and an exclusive escaped cursor", async () => {
    const unsafe = vi.fn().mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        id: `edge-${i}`,
        citing_id: "root",
        cited_id: `atom-${i}`,
        citation_type: "supports",
        context: null,
        source_title: "Root",
        target_title: `Atom ${i}`,
      }))
    );
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: { unsafe } as unknown as Sql,
    });
    const page = await store.listCitationLinks("root", "edge-'cursor");
    expect(page.links).toHaveLength(5);
    expect(page.nextCursor).toBe("edge-4");
    expect(page.links[0]?.targetTitle).toBe("Atom 0");
    expect(unsafe).toHaveBeenCalledOnce();
    const query = unsafe.mock.calls[0]?.[0] as string;
    expect(query).not.toMatch(/\b(content|outcome)\b|SELECT\s+\w*\.?\*/i);
    expect(query).toContain("id > 'edge-''cursor'");
    expect(query).toContain("WHERE citing_id = 'root'");
    expect(query).toContain("WHERE cited_id = 'root'");
    expect(query.match(/LIMIT 6/g)).toHaveLength(3);
  });

  it("terminates at a full last page and preserves missing endpoint titles", async () => {
    const unsafe = vi.fn().mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `edge-${i}`,
        citing_id: "root",
        cited_id: `task.${5000 + i}`,
        citation_type: "tracks",
      }))
    );
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: { unsafe } as unknown as Sql,
    });
    const page = await store.listCitationLinks("root");
    expect(page.links).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
    expect(page.links[0]?.targetTitle).toBeNull();
    unsafe.mockResolvedValue([]);
    expect(await store.listCitationLinks("missing")).toEqual({
      links: [],
      nextCursor: null,
    });
  });
});
