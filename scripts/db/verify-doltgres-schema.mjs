// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/verify-doltgres-schema`
 * Purpose: Shared post-migration schema verifier — compares the latest drizzle-kit snapshot against the live DB via information_schema and throws SCHEMA_DRIFT if anything is missing or shape-mismatched.
 * Scope: Pure verification; does not run DDL, does not write tracking rows, does not call dolt_commit.
 * Invariants: latest snapshot is authoritative end-state; checks table/column presence + nullability; throws synchronously on drift.
 * Side-effects: IO (Doltgres reads, filesystem reads).
 * Notes: Uses `sql.unsafe` due to Doltgres 0.56 extended-protocol gap.
 * Links: docs/spec/databases.md §2.6, scripts/db/migrate-doltgres.mjs
 */

// biome-ignore-all lint/suspicious/noConsole: standalone script; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: container entry point

import { readFile } from "node:fs/promises";
import path from "node:path";

const TS_TIMESTAMPTZ = /timestamp with time zone/i;
const TS_TIMESTAMP = /^timestamp/i;

function normalizeType(t) {
  // Snapshot uses drizzle-kit shorthand: 'text', 'integer', 'timestamp with time zone', 'jsonb', 'boolean'.
  // information_schema.columns.data_type returns: 'text', 'integer', 'timestamp with time zone',
  // 'jsonb', 'boolean' on Doltgres. Lowercase + trim is enough; serial maps to integer.
  const s = String(t).toLowerCase().trim();
  if (s === "serial") return "integer";
  if (TS_TIMESTAMPTZ.test(s)) return "timestamp with time zone";
  if (TS_TIMESTAMP.test(s) && !TS_TIMESTAMPTZ.test(s))
    return "timestamp without time zone";
  return s;
}

async function readLatestSnapshot(migrationsFolder) {
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")
  );
  const entries = journal.entries ?? [];
  if (entries.length === 0) {
    throw new Error(
      "verify-doltgres-schema: journal has no entries — cannot determine expected end-state"
    );
  }
  const latest = entries.reduce((a, b) => (b.idx > a.idx ? b : a));
  const padded = String(latest.idx).padStart(4, "0");
  const snapshotPath = path.join(
    migrationsFolder,
    "meta",
    `${padded}_snapshot.json`
  );
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  return { snapshot, latestEntry: latest };
}

function expectedTablesFromSnapshot(snapshot) {
  // snapshot.tables keys are `<schema>.<name>`; values have { name, columns, indexes }.
  // We only check presence + type + nullability; PK and uniqueness flags are
  // intentionally not extracted (drizzle-kit reorders/renormalizes them on
  // every regenerate, so they're noisy false positives).
  const tables = new Map();
  for (const value of Object.values(snapshot.tables ?? {})) {
    const columns = new Map();
    for (const col of Object.values(value.columns ?? {})) {
      columns.set(col.name, {
        type: normalizeType(col.type),
        notNull: !!col.notNull,
      });
    }
    const indexNames = new Set(
      Object.values(value.indexes ?? {}).map((idx) => idx.name)
    );
    tables.set(value.name, { columns, indexNames });
  }
  return tables;
}

export async function verifyDoltgresSchema(sql, migrationsFolder) {
  const { snapshot, latestEntry } = await readLatestSnapshot(migrationsFolder);
  const expected = expectedTablesFromSnapshot(snapshot);

  // Bulk-fetch live shape. sql.unsafe → simple protocol, sidesteps Doltgres
  // extended-protocol gap.
  const liveCols = await sql.unsafe(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);
  const liveIdx = await sql.unsafe(`
    SELECT tablename AS table_name, indexname AS index_name, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
  `);

  const liveTables = new Map();
  for (const row of liveCols) {
    if (!liveTables.has(row.table_name)) {
      liveTables.set(row.table_name, {
        columns: new Map(),
        indexes: new Set(),
      });
    }
    liveTables.get(row.table_name).columns.set(row.column_name, {
      type: normalizeType(row.data_type),
      notNull: row.is_nullable === "NO",
    });
  }
  for (const row of liveIdx) {
    if (!liveTables.has(row.table_name)) {
      liveTables.set(row.table_name, {
        columns: new Map(),
        indexes: new Set(),
      });
    }
    liveTables.get(row.table_name).indexes.add(row.index_name);
  }

  const missing = [];

  for (const [tableName, expectedTable] of expected) {
    const live = liveTables.get(tableName);
    if (!live) {
      missing.push(`table "${tableName}" missing`);
      continue;
    }
    for (const [colName, expectedCol] of expectedTable.columns) {
      const liveCol = live.columns.get(colName);
      if (!liveCol) {
        missing.push(`column "${tableName}"."${colName}" missing`);
        continue;
      }
      if (liveCol.type !== expectedCol.type) {
        missing.push(
          `column "${tableName}"."${colName}" type mismatch: expected ${expectedCol.type}, got ${liveCol.type}`
        );
      }
      if (expectedCol.notNull && !liveCol.notNull) {
        missing.push(
          `column "${tableName}"."${colName}" expected NOT NULL but live column is nullable`
        );
      }
    }
    for (const idxName of expectedTable.indexNames) {
      if (!live.indexes.has(idxName)) {
        missing.push(`index "${tableName}"."${idxName}" missing`);
      }
    }
  }

  if (missing.length > 0) {
    const err = new Error(
      `verify-doltgres-schema: live DB does not match snapshot ${latestEntry.tag} ` +
        `(${missing.length} discrepancies):\n  - ${missing.join("\n  - ")}\n\n` +
        `This deployed DB is older than the migrations on disk. The runtime\n` +
        `migrator silently skipped a migration because drizzle-orm tracks\n` +
        `"applied" by \`folderMillis\` (journal \`when\`), not file hash. Either\n` +
        `the migrations were modified after deploy (forbidden — see\n` +
        `scripts/db/check-migrations-immutable.mjs) or a forward migration\n` +
        `is needed to bring the DB to the expected shape.`
    );
    err.code = "SCHEMA_DRIFT";
    err.missing = missing;
    err.latestTag = latestEntry.tag;
    throw err;
  }

  return { ok: true, latestTag: latestEntry.tag, tablesChecked: expected.size };
}
