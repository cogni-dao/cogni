// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/edo-read-filter`
 * Purpose: Prove the default read filter (SCHEMA_REFINED_BY_READ_FILTER, R1 LibrarianReadFilter): searchKnowledge/listKnowledge hide EDO rows unless `includeEdo`, in both adapters and the capability, and the Doltgres search scans ids only (no content) then hydrates content by id in bounded batches, stopping at limit.
 * Scope: Fake adapter + capability + Doltgres adapter SQL shape over a scripted postgres.js stand-in. Does not exercise real Doltgres; nodes/operator/app/tests/component/db/doltgres-usewhen-patch.int.test.ts covers the SQL against a real engine in CI.
 * Invariants: SCHEMA_REFINED_BY_READ_FILTER, EDO_ENTRY_TYPES fail-closed.
 * Side-effects: none
 * Links: docs/spec/knowledge-syntropy.md, task.5308
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeStoreAdapter } from "../src/adapters/doltgres/index.js";
import { DoltBranchSessionRunner } from "../src/adapters/doltgres/session-admission.js";
import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";
import { createKnowledgeCapability } from "../src/capability.js";
import { EDO_ENTRY_TYPES, isEdoEntryType } from "../src/domain/schemas.js";

const ALL_TYPES = [
  "finding",
  "skill",
  "event",
  "hypothesis",
  "decision",
  "outcome",
] as const;

describe("EDO_ENTRY_TYPES", () => {
  it("enumerates exactly the four EDO beats", () => {
    expect([...EDO_ENTRY_TYPES].sort()).toEqual(
      ["decision", "event", "hypothesis", "outcome"].sort()
    );
    expect(isEdoEntryType("decision")).toBe(true);
    expect(isEdoEntryType("finding")).toBe(false);
    expect(isEdoEntryType(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

async function seededFake() {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "strategy", name: "Strategy" });
  await store.withWrite(
    { operationId: "fixture:edo-read-filter", message: "seed" },
    async (write) => {
      for (const t of ALL_TYPES) {
        await write.addKnowledge({
          id: `mission-${t}`,
          domain: "strategy",
          title: `Mission ${t}`,
          content: `mission loop ${t} row`,
          entryType: t,
          sourceType: "agent",
          ...(t === "hypothesis"
            ? { evaluateAt: new Date("2027-01-01T00:00:00Z") }
            : {}),
        });
      }
    }
  );
  return store;
}

const types = (rows: { entryType: string }[]) =>
  rows.map((r) => r.entryType).sort();

describe("FakeKnowledgeStoreAdapter — default EDO read filter", () => {
  it("searchKnowledge excludes EDO rows by default and includes them on opt-in", async () => {
    const store = await seededFake();
    expect(types(await store.searchKnowledge("strategy", "mission"))).toEqual([
      "finding",
      "skill",
    ]);
    expect(
      types(
        await store.searchKnowledge("strategy", "mission", { includeEdo: true })
      )
    ).toEqual([...ALL_TYPES].sort());
  });

  it("listKnowledge excludes EDO rows by default and includes them on opt-in", async () => {
    const store = await seededFake();
    expect(types(await store.listKnowledge("strategy"))).toEqual([
      "finding",
      "skill",
    ]);
    expect(
      types(await store.listKnowledge("strategy", { includeEdo: true }))
    ).toEqual([...ALL_TYPES].sort());
  });

  it("the capability search (core__knowledge_search path) omits decisions", async () => {
    const store = await seededFake();
    const results = await createKnowledgeCapability(store).search({
      domain: "strategy",
      query: "mission",
    });
    expect(results.map((r) => r.id).sort()).toEqual([
      "mission-finding",
      "mission-skill",
    ]);
  });

  it("capability search/list (core__knowledge_search / core__knowledge_read) return decisions only on includeEdo opt-in", async () => {
    const store = await seededFake();
    const capability = createKnowledgeCapability(store);
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

    const searchDefault = await capability.search({
      domain: "strategy",
      query: "mission",
    });
    const searchOptIn = await capability.search({
      domain: "strategy",
      query: "mission",
      includeEdo: true,
    });
    expect(ids(searchDefault)).not.toContain("mission-decision");
    expect(ids(searchOptIn)).toContain("mission-decision");
    expect(searchOptIn).toHaveLength(ALL_TYPES.length);

    const listDefault = await capability.list({ domain: "strategy" });
    const listOptIn = await capability.list({
      domain: "strategy",
      includeEdo: true,
    });
    expect(ids(listDefault)).not.toContain("mission-decision");
    expect(ids(listOptIn)).toContain("mission-decision");
    expect(listOptIn).toHaveLength(ALL_TYPES.length);
  });
});

// ---------------------------------------------------------------------------
// Doltgres adapter — scripted SQL stand-in
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  domain: string;
  title: string;
  content: string;
  entry_type: string;
  source_type: string;
  created_at: Date;
}

/** Answers the two read shapes `searchKnowledge`/`listKnowledge` issue. */
class ScriptedSql {
  readonly queries: string[] = [];
  constructor(private readonly table: Row[]) {}

  private visible(query: string): Row[] {
    const excludeEdo = query.includes("entry_type NOT IN");
    return this.table
      .filter((r) => query.includes(`domain = '${r.domain}'`))
      .filter((r) => !excludeEdo || !isEdoEntryType(r.entry_type))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  async unsafe(query: string): Promise<unknown[]> {
    this.queries.push(query);
    if (query.startsWith("SELECT id FROM knowledge WHERE domain")) {
      return this.visible(query).map((r) => ({ id: r.id }));
    }
    const inList = /WHERE id IN \((.*)\)$/.exec(query);
    if (inList?.[1]) {
      const ids = inList[1].split(", ").map((v) => v.slice(1, -1));
      return this.table.filter((r) => ids.includes(r.id));
    }
    if (query.startsWith("SELECT * FROM knowledge WHERE domain")) {
      return this.visible(query);
    }
    return [];
  }
}

function makeRows(count: number, entryTypes: readonly string[]): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const t = entryTypes[i % entryTypes.length] as string;
    return {
      id: `row-${String(i).padStart(3, "0")}`,
      domain: "strategy",
      title: `Row ${i}`,
      content: `mission loop ${t} body`,
      entry_type: t,
      source_type: "agent",
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    };
  });
}

function doltgresOver(table: Row[]) {
  const fake = new ScriptedSql(table);
  const sql = fake as unknown as Sql;
  const adapter = new DoltgresKnowledgeStoreAdapter({
    sql: { unsafe: sql.unsafe.bind(sql) } as unknown as Sql,
    writerSession: new DoltBranchSessionRunner(sql),
  });
  return { adapter, fake };
}

const EXCLUDE_SQL =
  "entry_type NOT IN ('event', 'hypothesis', 'decision', 'outcome')";

describe("DoltgresKnowledgeStoreAdapter — default EDO read filter", () => {
  it("searchKnowledge pushes the EDO exclusion into SQL and never selects content for the whole shelf", async () => {
    const { adapter, fake } = doltgresOver(makeRows(12, ALL_TYPES));
    const results = await adapter.searchKnowledge("strategy", "MISSION");
    expect(new Set(results.map((r) => r.entryType))).toEqual(
      new Set(["finding", "skill"])
    );
    const [scan, ...hydrates] = fake.queries;
    expect(scan).toBe(
      `SELECT id FROM knowledge WHERE domain = 'strategy' AND ${EXCLUDE_SQL} ORDER BY created_at DESC`
    );
    // Content is only ever read by id for candidates, never by shelf.
    for (const q of hydrates)
      expect(q).toMatch(/^SELECT \* FROM knowledge WHERE id IN \(/);
  });

  it("searchKnowledge opt-in drops the exclusion and returns EDO rows", async () => {
    const { adapter, fake } = doltgresOver(makeRows(12, ALL_TYPES));
    const results = await adapter.searchKnowledge("strategy", "mission", {
      includeEdo: true,
    });
    expect(new Set(results.map((r) => r.entryType))).toEqual(
      new Set(ALL_TYPES)
    );
    expect(fake.queries[0]).not.toContain("entry_type NOT IN");
  });

  it("searchKnowledge hydrates in bounded batches, newest first, and stops at limit", async () => {
    const { adapter, fake } = doltgresOver(makeRows(200, ["finding"]));
    const results = await adapter.searchKnowledge("strategy", "mission", {
      limit: 3,
    });
    expect(results.map((r) => r.id)).toEqual(["row-199", "row-198", "row-197"]);
    const hydrates = fake.queries.filter((q) => q.includes("WHERE id IN"));
    expect(hydrates).toHaveLength(1);
    expect(hydrates[0]?.split(", ").length).toBe(25);
  });

  it("listKnowledge excludes EDO rows by default and includes them on opt-in", async () => {
    const def = doltgresOver(makeRows(12, ALL_TYPES));
    expect(
      new Set(
        (await def.adapter.listKnowledge("strategy")).map((r) => r.entryType)
      )
    ).toEqual(new Set(["finding", "skill"]));
    expect(def.fake.queries[0]).toContain(EXCLUDE_SQL);

    const opt = doltgresOver(makeRows(12, ALL_TYPES));
    expect(
      new Set(
        (await opt.adapter.listKnowledge("strategy", { includeEdo: true })).map(
          (r) => r.entryType
        )
      )
    ).toEqual(new Set(ALL_TYPES));
    expect(opt.fake.queries[0]).not.toContain("entry_type NOT IN");
  });
});
