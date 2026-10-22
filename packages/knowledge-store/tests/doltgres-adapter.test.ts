// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/doltgres-adapter`
 * Purpose: Regression coverage for Doltgres adapter SQL generation around confidence policy.
 * Scope: Fake postgres.js client; does not connect to live Doltgres.
 * Invariants: NO_NULL_CONFIDENCE_WRITES, CONFIDENCE_IS_POLICY (explicit baseline written, never NULL).
 * Side-effects: none
 * Links: packages/knowledge-store/src/adapters/doltgres/index.ts, packages/knowledge-store/src/domain/confidence-policy.ts
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { DoltgresKnowledgeStoreAdapter } from "../src/adapters/doltgres/index.js";
import { DoltBranchSessionRunner } from "../src/adapters/doltgres/session-admission.js";
import { GoalRequiresContributionError } from "../src/domain/dao-goals.js";
import { CitationTargetNotFoundError } from "../src/port/knowledge-store.port.js";

type Rows = Record<string, unknown>[] & { count?: number };

const knowledgeRow = {
  id: "policy-row",
  domain: "meta",
  entity_id: null,
  title: "Policy row",
  content: "Confidence is initialized by the shared domain policy.",
  entry_type: "finding",
  confidence_pct: 30,
  source_type: "agent",
  source_ref: null,
  tags: null,
  evaluate_at: null,
  resolution_strategy: null,
  created_at: new Date("2026-06-14T00:00:00.000Z"),
} satisfies Record<string, unknown>;

function rows(values: Record<string, unknown>[], count?: number): Rows {
  const out = values as Rows;
  if (count !== undefined) out.count = count;
  return out;
}

class FakeSql {
  readonly queries: string[] = [];
  private active = "main";
  private dirty = false;
  private inserted = false;
  release() {}
  async reserve() {
    return this;
  }
  async end() {}

  constructor(
    private readonly knowledgeEntryTypes = new Map([["policy-row", "finding"]]),
    private readonly workItemIds = new Set<string>(),
    private readonly opts: { goalGuardMatches?: boolean } = {}
  ) {}

  async unsafe(query: string): Promise<Rows> {
    this.queries.push(query);
    if (query.includes("current_database()"))
      return rows([{ dolt_writer_database: "fake_knowledge" }]);
    if (query.includes("pg_try_advisory_lock"))
      return rows([{ pg_try_advisory_lock: true }]);
    if (query.includes("pg_advisory_unlock"))
      return rows([{ pg_advisory_unlock: true }]);
    if (query.includes("dolt.merge_status"))
      return rows([{ is_merging: false }]);
    if (query.includes("FROM dolt.branches")) return rows([]);
    if (query.startsWith("SELECT dolt_checkout('-b'")) {
      this.active = query.split("'")[3] ?? "";
      return rows([{ dolt_checkout: 0 }]);
    }
    if (query === "SELECT dolt_checkout('main')") {
      this.active = "main";
      return rows([{ dolt_checkout: 0 }]);
    }
    if (query.includes("active_branch()"))
      return rows([{ branch_name: this.active }]);
    if (query.includes("FROM dolt.status"))
      return rows(this.dirty ? [{ table_name: "knowledge" }] : []);
    if (query.startsWith("SELECT dolt_commit")) {
      this.dirty = false;
      return rows([{ dolt_commit: ["a".repeat(32)] }]);
    }
    if (query.startsWith("SELECT dolt_hashof"))
      return rows([{ commit_hash: "a".repeat(32) }]);
    if (query.startsWith("SELECT hash, fast_forward"))
      return rows([{ hash: "a".repeat(32), conflicts: 0 }]);
    if (query.startsWith("SELECT dolt_merge_base"))
      return rows([{ merge_base: "a".repeat(32) }]);
    if (query.startsWith("SELECT dolt_reset")) {
      this.dirty = false;
      return rows([{ dolt_reset: 0 }]);
    }
    if (/^(INSERT|UPDATE|DELETE)/.test(query)) this.dirty = true;
    if (query.includes("FROM work_items")) {
      return rows(
        Array.from(this.workItemIds).some((id) => query.includes(`'${id}'`))
          ? [{ "?column?": 1 }]
          : []
      );
    }
    if (query.includes("entry_type FROM knowledge")) {
      const id = Array.from(this.knowledgeEntryTypes.keys()).find((candidate) =>
        query.includes(`'${candidate}'`)
      );
      return id
        ? rows([{ entry_type: this.knowledgeEntryTypes.get(id) }])
        : rows([]);
    }
    if (query.includes("FROM domains")) return rows([{ "?column?": 1 }]);
    if (query.startsWith("INSERT INTO knowledge")) {
      this.inserted = true;
      return rows([knowledgeRow]);
    }
    if (query.startsWith("INSERT INTO citations")) {
      return rows([
        {
          id: "knowledge-row->task.5017:tracks",
          citing_id: "knowledge-row",
          cited_id: "task.5017",
          citation_type: "tracks",
          context: null,
          created_at: new Date("2026-06-14T00:00:00.000Z"),
        },
      ]);
    }
    if (query.startsWith("UPDATE knowledge"))
      return this.opts.goalGuardMatches === false
        ? rows([], 0)
        : rows([knowledgeRow], 1);
    if (query.startsWith("DELETE FROM knowledge"))
      return this.opts.goalGuardMatches === false ? rows([], 0) : rows([], 1);
    if (query.includes("SELECT * FROM knowledge WHERE id")) {
      return rows(this.inserted ? [knowledgeRow] : []);
    }
    return rows([]);
  }
}

function adapterFor(fake: FakeSql): DoltgresKnowledgeStoreAdapter {
  const sql = fake as unknown as Sql;
  return new DoltgresKnowledgeStoreAdapter({
    sql: { unsafe: sql.unsafe.bind(sql) } as unknown as Sql,
    writerSession: new DoltBranchSessionRunner(sql),
  });
}

function insertOf(fake: FakeSql): string {
  const insert = fake.queries.find((q) =>
    q.startsWith("INSERT INTO knowledge")
  );
  expect(insert).toBeDefined();
  return insert as string;
}

describe("DoltgresKnowledgeStoreAdapter — confidence policy on writes", () => {
  it("writes the source-type baseline (agent → 30) when confidence is omitted, never NULL", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).withWrite(
      { operationId: "policy:157", message: "policy fixture" },
      (write) =>
        write.addKnowledge({
          id: "policy-row",
          domain: "meta",
          title: "Policy row",
          content: "Omitted confidence resolves to the agent baseline.",
          sourceType: "agent",
        })
    );
    const insert = insertOf(fake);
    expect(insert).toContain("confidence_pct");
    expect(insert).not.toContain("NULL, 'agent'"); // confidence slot is not NULL
    expect(insert).toMatch(/30,\s*'agent'/);
  });

  it("treats null confidence as omitted and still writes the baseline (NO_NULL_CONFIDENCE_WRITES)", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).withWrite(
      { operationId: "policy:172", message: "policy fixture" },
      (write) =>
        write.addKnowledge({
          id: "policy-row",
          domain: "meta",
          title: "Policy row",
          content: "Null confidence resolves to the agent baseline.",
          sourceType: "agent",
          confidencePct: null,
        })
    );
    const insert = insertOf(fake);
    expect(insert).toContain("confidence_pct");
    expect(insert).toMatch(/30,\s*'agent'/);
  });

  it("writes the external baseline (50) when confidence is omitted", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).withWrite(
      { operationId: "policy:187", message: "policy fixture" },
      (write) =>
        write.addKnowledge({
          id: "policy-row",
          domain: "meta",
          title: "Policy row",
          content: "External baseline.",
          sourceType: "external",
          sourceRef: "https://example.com",
        })
    );
    expect(insertOf(fake)).toMatch(/50,\s*'external'/);
  });

  it("preserves an explicit confidence value", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).withWrite(
      { operationId: "policy:200", message: "policy fixture" },
      (write) =>
        write.addKnowledge({
          id: "policy-row",
          domain: "meta",
          title: "Policy row",
          content: "Explicit confidence is preserved.",
          sourceType: "human",
          confidencePct: 88,
        })
    );
    expect(insertOf(fake)).toMatch(/88,\s*'human'/);
  });

  it("never updates confidence_pct to NULL — a nullish update preserves the row", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).withWrite(
      { operationId: "policy:213", message: "policy fixture" },
      (write) =>
        write.updateKnowledge("policy-row", {
          title: "Renamed",
          confidencePct: null,
        })
    );
    const update = fake.queries.find((q) => q.startsWith("UPDATE knowledge"));
    expect(update).toBeDefined();
    expect(update).not.toContain("confidence_pct");
  });

  it("writes an explicit confidence on update", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).withWrite(
      { operationId: "policy:224", message: "policy fixture" },
      (write) => write.updateKnowledge("policy-row", { confidencePct: 55 })
    );
    const update = fake.queries.find((q) => q.startsWith("UPDATE knowledge"));
    expect(update).toContain("confidence_pct = 55");
  });
});

describe("DoltgresKnowledgeStoreAdapter — goal rows are contribution-only (task.5294)", () => {
  it("folds the goal guard into the raw UPDATE's WHERE clause", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).withWrite(
      { operationId: "goal:where", message: "policy fixture" },
      (write) => write.updateKnowledge("policy-row", { title: "Renamed" })
    );
    const update = fake.queries.find((q) => q.startsWith("UPDATE knowledge"));
    expect(update).toContain(
      "AND (entry_type IS NULL OR entry_type <> 'goal')"
    );
  });

  it("refuses a raw update or delete that matched no row because it is a goal", async () => {
    const fake = new FakeSql(new Map([["goal-ship", "goal"]]), new Set(), {
      goalGuardMatches: false,
    });
    const adapter = adapterFor(fake);
    await expect(
      adapter.withWrite(
        { operationId: "goal:raw-update", message: "rewrite a goal" },
        (write) =>
          write.updateKnowledge("goal-ship", { title: "Rewritten target" })
      )
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
    await expect(
      adapter.withWrite(
        { operationId: "goal:raw-delete", message: "delete a goal" },
        (write) => write.deleteKnowledge("goal-ship")
      )
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
  });

  it("refuses a raw retype into goal before any UPDATE", async () => {
    const fake = new FakeSql();
    await expect(
      adapterFor(fake).withWrite(
        { operationId: "goal:retype", message: "retype" },
        (write) => write.updateKnowledge("policy-row", { entryType: "goal" })
      )
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
    expect(fake.queries.some((q) => q.startsWith("UPDATE knowledge"))).toBe(
      false
    );
  });

  it("still updates a non-goal row (the confidence resolver path)", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).withWrite(
      { operationId: "goal:non-goal-update", message: "policy fixture" },
      (write) => write.updateKnowledge("policy-row", { confidencePct: 55 })
    );
    expect(fake.queries.some((q) => q.startsWith("UPDATE knowledge SET"))).toBe(
      true
    );
  });
});

describe("DoltgresKnowledgeStoreAdapter — work-item tracking citations", () => {
  it("rejects tracks edges when the non-work citing endpoint is not knowledge", async () => {
    const fake = new FakeSql(new Map(), new Set(["task.5017"]));

    await expect(
      adapterFor(fake).withWrite(
        { operationId: "policy:235", message: "policy fixture" },
        (write) =>
          write.addCitation({
            citingId: "missing-knowledge",
            citedId: "task.5017",
            citationType: "tracks",
          })
      )
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);

    expect(
      fake.queries.some(
        (q) =>
          q.includes("entry_type FROM knowledge") &&
          q.includes("'missing-knowledge'")
      )
    ).toBe(true);
  });

  it("accepts tracks edges when the non-work citing endpoint exists", async () => {
    const fake = new FakeSql(
      new Map([["knowledge-row", "finding"]]),
      new Set(["task.5017"])
    );

    const citation = await adapterFor(fake).withWrite(
      { operationId: "policy:257", message: "policy fixture" },
      (write) =>
        write.addCitation({
          citingId: "knowledge-row",
          citedId: "task.5017",
          citationType: "tracks",
        })
    );

    expect(citation.citationType).toBe("tracks");
    expect(
      fake.queries.some((q) => q.startsWith("INSERT INTO citations"))
    ).toBe(true);
  });
});
