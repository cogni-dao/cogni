// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/db/doltgres-work-item-ladder-migrations`
 * Purpose: Pins the operator Doltgres artifact ladder migrations (0011–0013) and the adopted artifact run attribution columns (0014).
 * Scope: Reads the checked-in migrations, journal, snapshots and the operator's drizzle tables. No database.
 * Invariants:
 *   - JOURNAL_CONTINUES: idx 11 through 14 follow 0010 with strictly increasing `when` (a lower `when` silently no-ops on a deployed database).
 *   - SNAPSHOT_CHAIN: each new snapshot chains from the one before it, starting at the operator's 0010 id.
 *   - SCHEMA_MATCHES: the ladder's 0013 snapshot matches the workspace Drizzle tables; 0014's released schema adoption is outside this source-aliased assertion.
 *   - LEGACY_QUEUE_FOLLOWS_THE_LADDER: 0013 backfills `status_revision` to `revision` and sends `needs_merge` rows to `needs_closeout`, the next stage after merge.
 * Side-effects: none (filesystem reads)
 * Links: .claude/skills/schema-update/SKILL.md, hub work-status-ladder
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { workItemArtifacts, workItems } from "@cogni/operator-doltgres-schema";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(
  __dirname,
  "../../../../../src/adapters/server/db/doltgres-migrations"
);
const read = (file: string) => readFileSync(path.join(DIR, file), "utf8");
const json = (file: string) => JSON.parse(read(file));

type Column = { name: string; type: string; notNull: boolean };
type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, Column> }>;
};

const TAGS = [
  "0011_work_item_artifacts",
  "0012_work_item_artifact_sequence",
  "0013_work_item_status_ladder",
  "0014_watery_johnny_blaze",
] as const;

describe("operator work-item ladder migrations 0011 to 0014", () => {
  const journal = json("meta/_journal.json") as {
    entries: { idx: number; when: number; tag: string }[];
  };

  it("continues the journal after 0010 with strictly increasing time", () => {
    const tail = journal.entries.filter((e) => e.idx >= 10);
    expect(tail.map((e) => [e.idx, e.tag])).toEqual([
      [10, "0010_work_item_moves"],
      [11, TAGS[0]],
      [12, TAGS[1]],
      [13, TAGS[2]],
      [14, TAGS[3]],
    ]);
    for (let i = 1; i < tail.length; i++)
      expect(tail[i]?.when).toBeGreaterThan(tail[i - 1]?.when ?? Infinity);
    for (const e of tail) {
      expect(() => read(`${e.tag}.sql`)).not.toThrow();
      expect(() =>
        read(`meta/${String(e.idx).padStart(4, "0")}_snapshot.json`)
      ).not.toThrow();
    }
  });

  it("chains its snapshots from the operator's 0010 id", () => {
    const ids = ["0010", "0011", "0012", "0013", "0014"].map(
      (n) => json(`meta/${n}_snapshot.json`) as Snapshot
    );
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]?.prevId).toBe(ids[i - 1]?.id);
      expect(ids[i]?.id).not.toBe(ids[i - 1]?.id);
    }
  });

  it("0011 only adds the work_item_artifacts table; every other table is the operator's own", () => {
    const prev = json("meta/0010_snapshot.json") as Snapshot;
    const next = json("meta/0011_snapshot.json") as Snapshot;
    expect(Object.keys(next.tables).filter((t) => !(t in prev.tables))).toEqual(
      ["public.work_item_artifacts"]
    );
    const { "public.work_item_artifacts": _added, ...rest } = next.tables;
    expect(rest).toEqual(prev.tables);
  });

  it("0013 adds exactly work_items.status_revision, an integer not null default 0", () => {
    const prev = json("meta/0012_snapshot.json") as Snapshot;
    const next = json("meta/0013_snapshot.json") as Snapshot;
    const table = "public.work_items";
    const added = Object.keys(next.tables[table]?.columns ?? {}).filter(
      (c) => !(c in (prev.tables[table]?.columns ?? {}))
    );
    expect(added).toEqual(["status_revision"]);
    expect(next.tables[table]?.columns.status_revision).toMatchObject({
      type: "integer",
      notNull: true,
      default: 0,
    });
  });

  it("0013 backfills status_revision and rewrites needs_merge to needs_closeout", () => {
    const sql = read("0013_work_item_status_ladder.sql");
    expect(sql).toContain(
      'UPDATE "work_items" SET "status_revision" = "revision"'
    );
    expect(sql).toContain(
      `UPDATE "work_items" SET "status" = 'needs_closeout' WHERE "status" = 'needs_merge'`
    );
  });

  it("matches the operator drizzle tables the released package uses", () => {
    const snapshot = json("meta/0013_snapshot.json") as Snapshot;
    const columnsOf = (table: Parameters<typeof getTableColumns>[0]) =>
      Object.values(getTableColumns(table))
        .map((c) => [c.name, c.getSQLType(), c.notNull])
        .sort();
    const snapshotColumns = (name: string) =>
      Object.values(snapshot.tables[name]?.columns ?? {})
        .map((c) => [c.name, c.type, c.notNull])
        .sort();
    expect(columnsOf(workItemArtifacts)).toEqual(
      snapshotColumns("public.work_item_artifacts")
    );
    expect(columnsOf(workItems)).toEqual(snapshotColumns("public.work_items"));
  });
});
