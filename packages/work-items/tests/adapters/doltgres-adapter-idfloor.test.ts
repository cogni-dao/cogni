// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-adapter-idfloor`
 * Purpose: Pin ID_FLOOR_IS_PER_STORE, so a node with an empty store starts at 0001 while operator still clears its imported corpus at 5000.
 * Scope: Fake `Sql` asserting the id in the emitted INSERT. Does not use a real database and does not cover concurrent allocation.
 * Invariants:
 *   - FRESH_NODE_STARTS_AT_ONE: empty store + default floor allocates `<type>.0001`.
 *   - OPERATOR_CLEARS_LEGACY_CORPUS: empty store + OPERATOR_ID_FLOOR allocates `<type>.5000`.
 *   - MAX_PLUS_ONE_WITHIN_STORE: existing rows advance the suffix, per type.
 * Side-effects: none
 * Links: story.5060, packages/work-items/src/adapters/doltgres/adapter.ts
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  DoltgresWorkItemAdapter,
  OPERATOR_ID_FLOOR,
} from "../../src/adapters/doltgres/adapter.js";

/** Fake `Sql` whose `work_items` table contains exactly `existingIds`. */
function makeFakeSql(existingIds: string[]): { sql: Sql; queries: string[] } {
  const queries: string[] = [];
  const respond = (q: string): unknown[] => {
    // The allocator's scan: every id of the requested type.
    if (q.startsWith("SELECT id FROM work_items WHERE type")) {
      return existingIds.map((id) => ({ id }));
    }
    if (q.startsWith("INSERT INTO work_items")) {
      // Echo back the id the adapter chose so rowToWorkItem is satisfied.
      const id = /VALUES \('([^']+)'/.exec(q)?.[1] ?? "";
      return [
        {
          id,
          type: id.split(".")[0],
          title: "t",
          status: "needs_triage",
          node: "shared",
          actor: "either",
          assignees: [],
          external_refs: [],
          labels: [],
          spec_refs: [],
          revision: 0,
          deploy_verified: false,
          created_at: "2026-10-02",
          updated_at: "2026-10-02",
        },
      ];
    }
    if (q.startsWith("SELECT dolt_commit")) return [{}];
    return [];
  };
  const fn = ((strings: TemplateStringsArray, ..._args: unknown[]) => {
    const q = Array.isArray(strings) ? strings.join("?") : String(strings);
    queries.push(q);
    return Promise.resolve(respond(q));
  }) as unknown as Sql;
  (fn as unknown as { unsafe: (q: string) => Promise<unknown[]> }).unsafe = (
    q: string
  ) => {
    queries.push(q);
    return Promise.resolve(respond(q));
  };
  return { sql: fn, queries };
}

describe("DoltgresWorkItemAdapter.create — ID_FLOOR_IS_PER_STORE", () => {
  it("starts a fresh node's empty store at 0001", async () => {
    const { sql } = makeFakeSql([]);
    const created = await new DoltgresWorkItemAdapter(sql).create(
      { type: "bug", title: "first bug on a brand-new node" },
      "actor:test"
    );

    // A node booting an empty store has no pre-API corpus to clear, so the
    // 5000 floor would be meaningless noise on its very first item.
    expect(created.id).toBe("bug.0001");
  });

  it("keeps operator clear of its imported pre-API corpus at 5000", async () => {
    const { sql } = makeFakeSql([]);
    const created = await new DoltgresWorkItemAdapter(sql, {
      idFloor: OPERATOR_ID_FLOOR,
    }).create({ type: "task", title: "operator task" }, "actor:test");

    expect(created.id).toBe("task.5000");
  });

  it("advances MAX(suffix)+1 within the store, scoped per type", async () => {
    // A poly-shaped store: bugs already present, no tasks yet.
    const { sql } = makeFakeSql(["bug.0001", "bug.0007", "bug.0003"]);
    const adapter = new DoltgresWorkItemAdapter(sql);

    expect((await adapter.create({ type: "bug", title: "b" }, "a")).id).toBe(
      "bug.0008"
    );
  });

  it("ignores ids of other types when allocating", async () => {
    // Only the requested type is scanned, so a high bug id must not push tasks.
    const { sql, queries } = makeFakeSql([]);
    const created = await new DoltgresWorkItemAdapter(sql).create(
      { type: "task", title: "t" },
      "a"
    );

    expect(created.id).toBe("task.0001");
    expect(
      queries.some((q) =>
        q.includes("SELECT id FROM work_items WHERE type = 'task'")
      )
    ).toBe(true);
  });
});
