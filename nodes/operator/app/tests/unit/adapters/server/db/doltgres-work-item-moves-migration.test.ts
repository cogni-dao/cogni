// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/db/doltgres-work-item-moves-migration`
 * Purpose: Pins the operator Doltgres migration that adds `work_items.moves` (story.0033).
 * Scope: Reads the checked-in migration, journal, snapshots and the operator's drizzle `work_items` table. No database.
 * Invariants:
 *   - ADD_ONLY: the migration adds one nullable jsonb column and changes nothing else.
 *   - JOURNAL_MONOTONIC: the entry is the next idx and its `when` is later than every earlier entry (a future-dated or lower `when` silently no-ops on a deployed database).
 *   - SNAPSHOT_CHAIN: the new snapshot chains from the previous one and differs from it by exactly this column.
 *   - SCHEMA_MATCHES: the operator's drizzle table declares the same column, so a reader that selects it needs the migration first. The migrate initContainer runs from the same image before the app container starts.
 * Side-effects: none (filesystem reads)
 * Links: .claude/skills/schema-update/SKILL.md, infra/k8s/overlays/production/operator/kustomization.yaml
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { workItems } from "@cogni/operator-doltgres-schema";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(
  __dirname,
  "../../../../../src/adapters/server/db/doltgres-migrations"
);
const read = (file: string) => readFileSync(path.join(DIR, file), "utf8");
const json = (file: string) => JSON.parse(read(file));

type Column = {
  name: string;
  type: string;
  notNull: boolean;
  default?: unknown;
};
type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, Column> }>;
};

describe("0010_work_item_moves", () => {
  const journal = json("meta/_journal.json") as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const entry = journal.entries.find((e) => e.tag === "0010_work_item_moves");

  it("adds exactly one nullable jsonb column and nothing else", () => {
    expect(read("0010_work_item_moves.sql").trim()).toBe(
      'ALTER TABLE "work_items" ADD COLUMN "moves" jsonb;'
    );
  });

  it("is the next journal entry, later than every earlier one", () => {
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(10);
    const earlier = journal.entries.filter((e) => e.idx < 10);
    expect(earlier.map((e) => e.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const e of earlier) expect(entry?.when).toBeGreaterThan(e.when);
    // Applied in journal order, and every tag has its file and snapshot.
    for (const e of journal.entries) {
      expect(() => read(`${e.tag}.sql`)).not.toThrow();
      expect(() =>
        read(`meta/${String(e.idx).padStart(4, "0")}_snapshot.json`)
      ).not.toThrow();
    }
  });

  it("chains its snapshot from 0009 and differs by exactly work_items.moves", () => {
    const prev = json("meta/0009_snapshot.json") as Snapshot;
    const next = json("meta/0010_snapshot.json") as Snapshot;
    expect(next.prevId).toBe(prev.id);
    expect(next.id).not.toBe(prev.id);

    const table = "public.work_items";
    const added = Object.keys(next.tables[table]?.columns ?? {}).filter(
      (c) => !(c in (prev.tables[table]?.columns ?? {}))
    );
    expect(added).toEqual(["moves"]);
    const moves = next.tables[table]?.columns.moves;
    expect(moves).toMatchObject({
      name: "moves",
      type: "jsonb",
      notNull: false,
    });
    expect(moves?.default).toBeUndefined();

    // Every other table and column is untouched.
    const strip = (snapshot: Snapshot) => {
      const copy = structuredClone(snapshot) as Snapshot;
      delete copy.tables[table]?.columns.moves;
      return copy.tables;
    };
    expect(strip(next)).toEqual(strip(prev));
  });

  it("matches the operator drizzle table: a nullable jsonb moves column", () => {
    const column = getTableColumns(workItems).moves;
    expect(column).toBeDefined();
    expect(column?.notNull).toBe(false);
    expect(column?.getSQLType()).toBe("jsonb");
    expect(column?.name).toBe("moves");
  });
});
