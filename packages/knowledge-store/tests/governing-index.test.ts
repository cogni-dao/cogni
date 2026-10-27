// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/governing-index`
 * Purpose: The governing predicate and the cross-domain governing index query, on the pure selector, the Doltgres adapter and the fake adapter.
 * Scope: Fake postgres.js client and in-memory fake store; does not connect to live Doltgres.
 * Invariants: GOVERNING_SET_DEFINED_ONCE, INDEX_BUILT_BY_OWN_QUERY, SUPERSEDED_EXCLUDED, NO_USEWHEN_NO_ROUTE, INDEX_CARRIES_NO_CONTENT.
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/governing.ts, https://cognidao.org/knowledge/guidance-routing-design
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeStoreAdapter } from "../src/adapters/doltgres/index.js";
import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";
import { createKnowledgeCapability } from "../src/capability.js";
import {
  GOVERNING_ENTRY_TYPES,
  isGoverningEntryType,
  selectGoverningIndex,
} from "../src/domain/governing.js";

const row = (
  id: string,
  entryType: string,
  useWhen: string | null = `when ${id} applies`,
  domain = "method"
) => ({ id, domain, entryType, useWhen });

describe("governing predicate (GOVERNING_SET_DEFINED_ONCE)", () => {
  it("names exactly the seven governing entry types from the design", () => {
    expect([...GOVERNING_ENTRY_TYPES].sort()).toEqual(
      [
        "decision",
        "design",
        "guide",
        "playbook",
        "reference",
        "rule",
        "skill",
      ].sort()
    );
    for (const t of ["finding", "observation", "hypothesis", "html"]) {
      expect(isGoverningEntryType(t)).toBe(false);
    }
    expect(isGoverningEntryType("rule")).toBe(true);
    expect(isGoverningEntryType(undefined)).toBe(false);
  });

  it("keeps governing types with a useWhen and drops evidence types", () => {
    const out = selectGoverningIndex(
      [
        row("a-rule", "rule"),
        row("a-finding", "finding"),
        row("a-scorecard", "scorecard"),
        row("a-html", "html"),
        row("a-skill", "skill"),
      ],
      []
    );
    expect(out.map((r) => r.id)).toEqual(["a-rule", "a-skill"]);
  });

  it("NO_USEWHEN_NO_ROUTE: a null or blank useWhen never routes", () => {
    const out = selectGoverningIndex(
      [
        row("no-trigger", "decision", null),
        row("blank-trigger", "rule", "   "),
        row("has-trigger", "decision"),
      ],
      []
    );
    expect(out.map((r) => r.id)).toEqual(["has-trigger"]);
  });

  it("SUPERSEDED_EXCLUDED: only an inbound supersedes edge retires a row", () => {
    const out = selectGoverningIndex(
      [row("old-rule", "rule"), row("new-rule", "rule"), row("cited", "rule")],
      [
        { citedId: "old-rule", citationType: "supersedes" },
        { citedId: "cited", citationType: "extends" },
        { citedId: "cited", citationType: "supports" },
      ]
    );
    expect(out.map((r) => r.id)).toEqual(["cited", "new-rule"]);
  });

  it("INDEX_CARRIES_NO_CONTENT: rows carry id, domain, entryType, useWhen only, sorted by domain then id", () => {
    const out = selectGoverningIndex(
      [
        {
          ...row("z-guide", "guide", "  deploying a node  ", "use-ship"),
          title: "claim",
          content: "body",
        },
        row("b-rule", "rule", "x", "method"),
        row("a-rule", "rule", "y", "method"),
      ],
      []
    );
    expect(out).toEqual([
      { id: "a-rule", domain: "method", entryType: "rule", useWhen: "y" },
      { id: "b-rule", domain: "method", entryType: "rule", useWhen: "x" },
      {
        id: "z-guide",
        domain: "use-ship",
        entryType: "guide",
        useWhen: "deploying a node",
      },
    ]);
  });
});

/** Answers the two governing reads (knowledge rows, supersedes edges). */
class FakeSql {
  readonly queries: string[] = [];
  constructor(
    private readonly knowledge: Record<string, unknown>[],
    private readonly citations: Record<string, unknown>[]
  ) {}
  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (/FROM citations/i.test(query)) return this.citations;
    return this.knowledge;
  }
}

describe("DoltgresKnowledgeStoreAdapter.listGoverningIndex (INDEX_BUILT_BY_OWN_QUERY)", () => {
  it("reads every governing row across domains in one unpaged query and drops supersedes targets", async () => {
    const knowledge = [
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `rule-${String(i).padStart(3, "0")}`,
        domain: "method",
        entry_type: "rule",
        use_when: `situation ${i}`,
      })),
      {
        id: "retired",
        domain: "use-ship",
        entry_type: "guide",
        use_when: "old",
      },
      {
        id: "untriggered",
        domain: "strategy",
        entry_type: "decision",
        use_when: null,
      },
    ];
    const fake = new FakeSql(knowledge, [
      { cited_id: "retired", citation_type: "supersedes" },
    ]);
    const adapter = new DoltgresKnowledgeStoreAdapter({
      sql: fake as unknown as Sql,
    });

    const out = await adapter.listGoverningIndex();

    // Past the old PER_DOMAIN_LIMIT of 50: no per-domain page (bug.5350).
    expect(out).toHaveLength(120);
    expect(out.some((r) => r.id === "retired")).toBe(false);
    expect(out.some((r) => r.id === "untriggered")).toBe(false);
    const read = fake.queries.find((q) => /FROM knowledge/i.test(q)) ?? "";
    expect(read).not.toMatch(/LIMIT/i);
    expect(read).not.toMatch(/\bcontent\b/i);
    for (const t of GOVERNING_ENTRY_TYPES) expect(read).toContain(`'${t}'`);
    const edges = fake.queries.find((q) => /FROM citations/i.test(q)) ?? "";
    expect(edges).toContain("'supersedes'");
  });
});

describe("FakeKnowledgeStoreAdapter.listGoverningIndex — parity", () => {
  it("selects the same governing rows as the Doltgres adapter", async () => {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "method", name: "method" });
    await store.registerDomain({ id: "use-ship", name: "use-ship" });
    await store.withWrite(
      { operationId: "fixture:governing", message: "seed governing" },
      async (write) => {
        const add = (
          id: string,
          domain: string,
          entryType: string,
          useWhen: string | null
        ) =>
          write.addKnowledge({
            id,
            domain,
            title: `title ${id}`,
            content: `body ${id}`,
            entryType,
            useWhen,
            sourceType: "human",
          });
        await add("old-rule", "method", "rule", "old situation");
        await add("new-rule", "method", "rule", "new situation");
        await add("a-finding", "method", "finding", "evidence");
        await add("ship-guide", "use-ship", "guide", "shipping");
        await add("no-trigger", "use-ship", "skill", null);
        await write.addCitation({
          citingId: "new-rule",
          citedId: "old-rule",
          citationType: "supersedes",
        });
      }
    );

    expect(await store.listGoverningIndex()).toEqual([
      {
        id: "new-rule",
        domain: "method",
        entryType: "rule",
        useWhen: "new situation",
      },
      {
        id: "ship-guide",
        domain: "use-ship",
        entryType: "guide",
        useWhen: "shipping",
      },
    ]);
  });
});

describe("createKnowledgeCapability.listGoverningIndex (ONE_SOURCE_SEPARATE_ADAPTERS)", () => {
  it("returns exactly the port's governing rows for core__knowledge_index", async () => {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "method", name: "method" });
    await store.withWrite(
      { operationId: "fixture:governing-cap", message: "seed" },
      (write) =>
        write.addKnowledge({
          id: "a-rule",
          domain: "method",
          title: "claim",
          content: "body",
          entryType: "rule",
          useWhen: "reviewing a claim",
          sourceType: "human",
        })
    );
    const capability = createKnowledgeCapability(store);
    expect(await capability.listGoverningIndex?.()).toEqual(
      await store.listGoverningIndex()
    );
    expect(await capability.listGoverningIndex?.()).toEqual([
      {
        id: "a-rule",
        domain: "method",
        entryType: "rule",
        useWhen: "reviewing a claim",
      },
    ]);
  });
});
