// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/domain-registry`
 * Purpose: Regression coverage for guarded domain deletion and Dolt commits.
 * Scope: In-memory adapter behavior plus Doltgres SQL generation with a fake client.
 * Invariants: DOMAIN_DELETE_EMPTY_ONLY, DOMAIN_DELETE_AUTOCOMMITS.
 * Side-effects: none
 * Links: packages/knowledge-store/src/port/knowledge-store.port.ts
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeStoreAdapter } from "../src/adapters/doltgres/index.js";
import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";

type Rows = Record<string, unknown>[];

class DomainSql {
  readonly queries: string[] = [];

  constructor(
    private readonly entryCount: number,
    private readonly referenceCount: number,
    private readonly exists = true
  ) {}

  async unsafe(query: string): Promise<Rows> {
    this.queries.push(query);
    if (query.startsWith("SELECT (SELECT COUNT(*) FROM knowledge")) {
      return [
        {
          entry_count: this.entryCount,
          reference_count: this.referenceCount,
        },
      ];
    }
    if (query.startsWith("DELETE FROM domains")) {
      return this.exists ? [{ id: "obsolete" }] : [];
    }
    return [];
  }
}

describe("domain registry deletion", () => {
  it("deletes an empty fake domain and records one commit", async () => {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "obsolete", name: "Obsolete" });

    await expect(store.deleteDomain("obsolete")).resolves.toBe(true);
    await expect(store.domainExists("obsolete")).resolves.toBe(false);
    expect(store.commitLog.at(-1)?.message).toBe("delete domain obsolete");
  });

  it("returns typed usage counts without deleting a populated domain", async () => {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "operator", name: "Operator" });
    await store.addKnowledge({
      id: "first",
      domain: "operator",
      title: "First",
      content: "First claim",
      sourceType: "agent",
    });
    await store.addKnowledge({
      id: "second",
      domain: "operator",
      title: "Second",
      content: "Second claim",
      sourceType: "agent",
    });
    await store.addCitation({
      citingId: "second",
      citedId: "first",
      citationType: "supports",
    });

    await expect(store.deleteDomain("operator")).rejects.toMatchObject({
      name: "DomainInUseError",
      domain: "operator",
      entryCount: 2,
      referenceCount: 1,
    });
    await expect(store.domainExists("operator")).resolves.toBe(true);
  });

  it("Doltgres deletion guards usage and auto-commits successful removal", async () => {
    const sql = new DomainSql(0, 0);
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: sql as unknown as Sql,
    });

    await expect(store.deleteDomain("obsolete")).resolves.toBe(true);
    expect(
      sql.queries.some((query) => query.startsWith("DELETE FROM domains"))
    ).toBe(true);
    expect(
      sql.queries.some((query) =>
        query.includes("dolt_commit('-Am', 'delete domain obsolete')")
      )
    ).toBe(true);
  });

  it("Doltgres deletion throws before DELETE or commit while referenced", async () => {
    const sql = new DomainSql(3, 2);
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: sql as unknown as Sql,
    });

    await expect(store.deleteDomain("operator")).rejects.toMatchObject({
      name: "DomainInUseError",
      domain: "operator",
      entryCount: 3,
      referenceCount: 2,
    });
    expect(
      sql.queries.some((query) => query.startsWith("DELETE FROM domains"))
    ).toBe(false);
    expect(sql.queries.some((query) => query.includes("dolt_commit"))).toBe(
      false
    );
  });
});
