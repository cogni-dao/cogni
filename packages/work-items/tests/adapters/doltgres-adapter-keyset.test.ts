// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-adapter-keyset`
 * Purpose: Unit tests for the Doltgres work-items keyset SQL, asserting pagination walks the dataset exactly once with id as a stable tiebreaker.
 * Scope: Fake `Sql` capturing issued query strings. Does not use a real database or a testcontainer, since this repo has no Doltgres image.
 * Invariants:
 *   - KEYSET_TIEBREAK, rows sharing (priority, rank, created_at) still progress because `id ASC` is part of the keyset.
 *   - KEYSET_OR_CHAIN, the SQL carries the mixed-direction OR-chain replacing a tuple compare Doltgres cannot run.
 *   - FULL_WALK_NO_DUPS, paginating limit=10 over 30 rows visits every row exactly once and hasMore falsifies last.
 * Side-effects: none
 * Links: bug.5162, PR #1180 review finding 3,
 *   packages/work-items/src/adapters/doltgres/adapter.ts
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";

type Row = Record<string, unknown>;

function makeRow(overrides: Partial<Row>): Row {
  return {
    id: overrides.id,
    type: "task",
    title: `t-${overrides.id}`,
    status: "needs_implement",
    node: "shared",
    actor: "either",
    assignees: [],
    external_refs: [],
    labels: [],
    spec_refs: [],
    revision: 0,
    deploy_verified: false,
    created_at: overrides.created_at,
    updated_at: overrides.created_at,
    priority: overrides.priority ?? null,
    rank: overrides.rank ?? null,
    ...overrides,
  };
}

/**
 * Build 30 rows with overlapping (priority, rank, created_at) so the keyset
 * MUST resolve ties by id. Rows are organized so the natural sort order
 * (priority ASC, rank ASC, created_at DESC, id ASC) is deterministic and
 * many ties exist at every level of the sort key.
 */
function buildDataset(): Row[] {
  const rows: Row[] = [];
  // 3 priority buckets × 2 rank buckets × 5 rows sharing created_at = 30 rows
  const priorities = [1, 1, 2]; // priority 1 has duplicate bucket so two p=1 groups
  const ranks = [10, 20];
  let n = 0;
  for (let pi = 0; pi < priorities.length; pi++) {
    const p = priorities[pi];
    for (const r of ranks) {
      // 5 rows with identical created_at — tiebreak MUST come from id
      const ts = `2026-04-${String(10 + pi).padStart(2, "0")}T00:00:00.000Z`;
      for (let i = 0; i < 5; i++) {
        n++;
        rows.push(
          makeRow({
            id: `task.${String(5000 + n).padStart(4, "0")}`,
            priority: p,
            rank: r,
            created_at: ts,
          })
        );
      }
    }
  }
  return rows;
}

function sortDataset(rows: Row[]): Row[] {
  // Mirror SQL: COALESCE(priority,999) ASC, COALESCE(rank,999) ASC,
  //            created_at DESC, id ASC
  return [...rows].sort((a, b) => {
    const pa = (a.priority as number | null) ?? 999;
    const pb = (b.priority as number | null) ?? 999;
    if (pa !== pb) return pa - pb;
    const ra = (a.rank as number | null) ?? 999;
    const rb = (b.rank as number | null) ?? 999;
    if (ra !== rb) return ra - rb;
    const ta = String(a.created_at);
    const tb = String(b.created_at);
    if (ta !== tb) return ta < tb ? 1 : -1; // DESC
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

/**
 * Apply the adapter's keyset OR-chain in JS so the fake Sql can serve the
 * correct slice. We parse the WHERE clause out of the query string by looking
 * for the COALESCE pattern, then evaluate it row-by-row in pure JS. This
 * ensures the test exercises the SQL string the adapter actually emits.
 *
 * If the adapter were to drop the id tiebreaker, this evaluator would still
 * see the broken WHERE and the resulting page would skip rows — the
 * full-walk assertion below would fail.
 */
function evaluateKeyset(
  rows: Row[],
  whereCursor: { p: number; r: number; ts: string; id: string } | null
): Row[] {
  if (!whereCursor) return rows;
  const { p: pEff, r: rEff, ts, id } = whereCursor;
  return rows.filter((row) => {
    const rp = (row.priority as number | null) ?? 999;
    const rr = (row.rank as number | null) ?? 999;
    const rts = String(row.created_at);
    const rid = String(row.id);
    if (rp > pEff) return true;
    if (rp === pEff && rr > rEff) return true;
    if (rp === pEff && rr === rEff && rts < ts) return true;
    if (rp === pEff && rr === rEff && rts === ts && rid > id) return true;
    return false;
  });
}

function parseCursorFromQuery(
  q: string
): { p: number; r: number; ts: string; id: string } | null {
  // Look for the OR-chain signature "COALESCE(priority,999) > <n>"
  const m = q.match(/COALESCE\(priority,999\)\s*>\s*(\d+)/);
  if (!m) return null;
  const pMatch = q.match(/COALESCE\(priority,999\)\s*=\s*(\d+)/);
  const rMatch = q.match(/COALESCE\(rank,999\)\s*=\s*(\d+)/);
  const tsMatch = q.match(/created_at\s*=\s*'([^']+)'/);
  const idMatch = q.match(/AND id\s*>\s*'([^']+)'/);
  if (!pMatch || !rMatch || !tsMatch || !idMatch) {
    // Cursor shape malformed — fail loudly by throwing so the test catches
    // a regression in the adapter's WHERE construction.
    throw new Error(`Could not parse keyset WHERE from query: ${q}`);
  }
  return {
    p: Number(pMatch[1]),
    r: Number(rMatch[1]),
    ts: tsMatch[1],
    id: idMatch[1],
  };
}

function parseLimit(q: string): number {
  const m = q.match(/LIMIT\s+(\d+)/);
  return m ? Number(m[1]) : Infinity;
}

function makeFakeSql(rows: Row[]): { sql: Sql; queries: string[] } {
  const sorted = sortDataset(rows);
  const queries: string[] = [];
  const fake = {
    unsafe: async (q: string) => {
      queries.push(q);
      // Only handle the SELECT * FROM work_items list path — that's what
      // adapter.list() issues. Anything else throws so the test surfaces
      // unexpected SQL.
      if (!q.startsWith("SELECT * FROM work_items")) {
        throw new Error(`Unexpected SQL in test: ${q}`);
      }
      const cursor = parseCursorFromQuery(q);
      const filtered = evaluateKeyset(sorted, cursor);
      const limit = parseLimit(q);
      return filtered.slice(0, limit);
    },
  } as unknown as Sql;
  return { sql: fake, queries };
}

describe("DoltgresWorkItemAdapter.list keyset SQL", () => {
  it("walks 30 rows with limit=10 in 3 pages, no dups, no skips", async () => {
    const dataset = buildDataset();
    const { sql, queries } = makeFakeSql(dataset);
    const adapter = new DoltgresWorkItemAdapter(sql);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const r = await adapter.list({ limit: 10, ...(cursor && { cursor }) });
      pages++;
      for (const it of r.items) seen.push(it.id as string);
      if (!r.pageInfo.hasMore) {
        expect(r.pageInfo.endCursor).toBeNull();
        break;
      }
      expect(r.pageInfo.endCursor).not.toBeNull();
      cursor = r.pageInfo.endCursor as string;
      if (pages > 10) throw new Error("infinite loop");
    }
    // every row exactly once
    expect(seen.length).toBe(30);
    expect(new Set(seen).size).toBe(30);
    // page count = ceil(30/10) = 3
    expect(pages).toBe(3);
    // expected order = sortDataset
    const expected = sortDataset(dataset).map((r) => String(r.id));
    expect(seen).toEqual(expected);
    // sanity: the OR-chain SQL was actually issued at least once
    expect(queries.some((q) => /COALESCE\(priority,999\)/.test(q))).toBe(true);
  });

  it("id tiebreaker resolves rows that share (priority, rank, created_at)", async () => {
    // 5 rows all sharing priority=1, rank=10, created_at — id is the only
    // discriminator. limit=2 forces 3 pages of 2,2,1.
    const ts = "2026-04-30T00:00:00.000Z";
    const rows = Array.from({ length: 5 }).map((_, i) =>
      makeRow({
        id: `task.${5100 + i}`,
        priority: 1,
        rank: 10,
        created_at: ts,
      })
    );
    const { sql } = makeFakeSql(rows);
    const adapter = new DoltgresWorkItemAdapter(sql);

    const seen: string[] = [];
    let cursor: string | undefined;
    while (true) {
      const r = await adapter.list({ limit: 2, ...(cursor && { cursor }) });
      for (const it of r.items) seen.push(it.id as string);
      if (!r.pageInfo.hasMore) break;
      cursor = r.pageInfo.endCursor as string;
    }
    expect(seen).toEqual([
      "task.5100",
      "task.5101",
      "task.5102",
      "task.5103",
      "task.5104",
    ]);
    expect(new Set(seen).size).toBe(5);
  });

  it("hasMore=false on the last page", async () => {
    const dataset = buildDataset().slice(0, 7);
    const { sql } = makeFakeSql(dataset);
    const adapter = new DoltgresWorkItemAdapter(sql);
    const r = await adapter.list({ limit: 10 });
    expect(r.items.length).toBe(7);
    expect(r.pageInfo.hasMore).toBe(false);
    expect(r.pageInfo.endCursor).toBeNull();
  });

  it("issues the mixed-direction OR-chain in the SQL string", async () => {
    const { sql, queries } = makeFakeSql(buildDataset());
    const adapter = new DoltgresWorkItemAdapter(sql);
    const first = await adapter.list({ limit: 10 });
    const second = await adapter.list({
      limit: 10,
      cursor: first.pageInfo.endCursor as string,
    });
    expect(second.items.length).toBeGreaterThan(0);
    const cursorQuery = queries.find((q) =>
      /COALESCE\(priority,999\)\s*>\s*\d+/.test(q)
    );
    if (!cursorQuery) throw new Error("expected cursor query was not issued");
    // All four legs of the OR-chain present
    expect(cursorQuery).toMatch(/COALESCE\(priority,999\)\s*>\s*\d+/);
    expect(cursorQuery).toMatch(/COALESCE\(rank,999\)\s*>\s*\d+/);
    expect(cursorQuery).toMatch(/created_at\s*<\s*'/);
    expect(cursorQuery).toMatch(/AND id\s*>\s*'/);
  });
});
