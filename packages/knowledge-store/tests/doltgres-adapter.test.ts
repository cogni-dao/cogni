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

  async unsafe(query: string): Promise<Rows> {
    this.queries.push(query);
    if (query.includes("FROM domains")) return rows([{ "?column?": 1 }]);
    if (query.startsWith("INSERT INTO knowledge")) return rows([knowledgeRow]);
    if (query.startsWith("UPDATE knowledge")) return rows([knowledgeRow], 1);
    if (query.includes("SELECT * FROM knowledge WHERE id")) {
      return rows([knowledgeRow]);
    }
    return rows([]);
  }
}

function adapterFor(fake: FakeSql): DoltgresKnowledgeStoreAdapter {
  return new DoltgresKnowledgeStoreAdapter({ sql: fake as unknown as Sql });
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
    await adapterFor(fake).addKnowledge({
      id: "policy-row",
      domain: "meta",
      title: "Policy row",
      content: "Omitted confidence resolves to the agent baseline.",
      sourceType: "agent",
    });
    const insert = insertOf(fake);
    expect(insert).toContain("confidence_pct");
    expect(insert).not.toContain("NULL, 'agent'"); // confidence slot is not NULL
    expect(insert).toMatch(/30,\s*'agent'/);
  });

  it("treats null confidence as omitted and still writes the baseline (NO_NULL_CONFIDENCE_WRITES)", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).addKnowledge({
      id: "policy-row",
      domain: "meta",
      title: "Policy row",
      content: "Null confidence resolves to the agent baseline.",
      sourceType: "agent",
      confidencePct: null,
    });
    const insert = insertOf(fake);
    expect(insert).toContain("confidence_pct");
    expect(insert).toMatch(/30,\s*'agent'/);
  });

  it("writes the external baseline (50) when confidence is omitted", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).addKnowledge({
      id: "policy-row",
      domain: "meta",
      title: "Policy row",
      content: "External baseline.",
      sourceType: "external",
      sourceRef: "https://example.com",
    });
    expect(insertOf(fake)).toMatch(/50,\s*'external'/);
  });

  it("preserves an explicit confidence value", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).addKnowledge({
      id: "policy-row",
      domain: "meta",
      title: "Policy row",
      content: "Explicit confidence is preserved.",
      sourceType: "human",
      confidencePct: 88,
    });
    expect(insertOf(fake)).toMatch(/88,\s*'human'/);
  });

  it("never updates confidence_pct to NULL — a nullish update preserves the row", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).updateKnowledge("policy-row", {
      title: "Renamed",
      confidencePct: null,
    });
    const update = fake.queries.find((q) => q.startsWith("UPDATE knowledge"));
    expect(update).toBeDefined();
    expect(update).not.toContain("confidence_pct");
  });

  it("writes an explicit confidence on update", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).updateKnowledge("policy-row", { confidencePct: 55 });
    const update = fake.queries.find((q) => q.startsWith("UPDATE knowledge"));
    expect(update).toContain("confidence_pct = 55");
  });
});
