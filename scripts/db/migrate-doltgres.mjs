// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/migrate-doltgres`
 * Purpose: Shared Doltgres migrator runner — Doltgres analogue of `scripts/db/migrate.mjs`. Each node's runtime image COPYs this script alongside its own `doltgres-migrations/` dir.
 * Scope: Per-node Doltgres migrations only — migrate + verify + dolt_commit. Does not seed reference data, does not provision the database.
 * Invariants: NODE_NAME + DATABASE_URL from env; argv[2] = migrations dir; verifier throws SCHEMA_DRIFT before any tracking-row stamping on shape drift.
 * Side-effects: IO (Doltgres connect, DDL, tracking-row writes, dolt_commit).
 * Notes: Three surgical deltas from scripts/db/migrate.mjs are driven by upstream Doltgres 0.56 gaps — see docs/spec/databases.md §5.2 parity matrix.
 * Links: scripts/db/verify-doltgres-schema.mjs (load-bearing post-migrate check), docs/spec/databases.md §5.2
 */

// biome-ignore-all lint/suspicious/noConsole: standalone Node script invoked as initContainer CMD; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: container entry point reads DATABASE_URL + NODE_NAME directly; no env wrapper to hide behind

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { verifyDoltgresSchema } from "./verify-doltgres-schema.mjs";

const NODE = `${process.env.NODE_NAME?.trim() || "unknown"}-doltgres`;

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error(`FATAL(${NODE}): DATABASE_URL is required`);
  process.exit(2);
}

const migrationsFolder = process.argv[2];
if (!migrationsFolder) {
  console.error(`FATAL(${NODE}): argv[2] migrations dir is required`);
  process.exit(2);
}

function hashOfMigration(sqlText) {
  return createHash("sha256").update(sqlText).digest("hex");
}

function isAlreadyAppliedError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err?.cause instanceof Error ? err.cause.message : "";
  const combined = `${msg} ${cause}`;
  return (
    /already exists/i.test(combined) || /duplicate key value/i.test(combined)
  );
}

async function reconcileTracking(sql, folder) {
  const journal = JSON.parse(
    await readFile(path.join(folder, "meta", "_journal.json"), "utf8")
  );
  const sqlEscape = (v) => `'${String(v).replace(/'/g, "''")}'`;

  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
  );

  let stamped = 0;
  for (const entry of journal.entries ?? []) {
    const sqlPath = path.join(folder, `${entry.tag}.sql`);
    const sqlText = await readFile(sqlPath, "utf8");
    const hash = hashOfMigration(sqlText);
    const existing = await sql.unsafe(
      `SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${sqlEscape(hash)} LIMIT 1`
    );
    if (existing.length === 0) {
      await sql.unsafe(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${sqlEscape(hash)}, ${Number(entry.when)})`
      );
      stamped += 1;
    }
  }
  return stamped;
}

async function withConnection(fn) {
  const sql = postgres(url, {
    max: 1,
    onnotice: (n) => console.log(n.message),
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  const t0 = Date.now();
  let migrateThrewAlreadyApplied = false;
  try {
    await withConnection((sql) => migrate(drizzle(sql), { migrationsFolder }));
  } catch (err) {
    if (!isAlreadyAppliedError(err)) throw err;
    migrateThrewAlreadyApplied = true;
    console.warn(
      `⚠️  ${NODE} drizzle-migrate hit "already exists" — schema in place; will verify before reconciling`
    );
  }

  // VERIFICATION GATE — must pass before any tracking-row stamping. If the live
  // shape doesn't match the latest snapshot, throw; do NOT pretend the schema
  // is applied just because the SQL files happen to live on disk.
  const verifyResult = await withConnection((sql) =>
    verifyDoltgresSchema(sql, migrationsFolder)
  );
  console.log(
    `✓ ${NODE} schema verified against snapshot ${verifyResult.latestTag} (${verifyResult.tablesChecked} table(s))`
  );

  const stampedRows = await withConnection((sql) =>
    reconcileTracking(sql, migrationsFolder)
  );
  await withConnection(
    (sql) => sql`SELECT dolt_commit('-Am', 'migration: drizzle-orm batch')`
  );
  console.log(
    `✅ ${NODE} migrations ${migrateThrewAlreadyApplied ? "already-applied" : "applied"} + verified + ${stampedRows} tracking row(s) reconciled + dolt_commit stamped in ${Date.now() - t0}ms`
  );
} catch (err) {
  console.error(`FATAL(${NODE}): migrate failed:`, err);
  process.exitCode = 1;
}
