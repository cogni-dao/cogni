// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/migrate-doltgres`
 * Purpose: Shared Doltgres migrator — Doltgres analogue of `scripts/db/migrate.mjs`. Each node's runtime image COPYs this script alongside its own `doltgres-migrations/` dir.
 * Scope: Migrate + verify + dolt_commit. Does not seed reference data, does not provision the database.
 * Invariants: NODE_NAME + DATABASE_URL from env; argv[2] = migrations dir; verifier throws SCHEMA_DRIFT on shape drift.
 * Side-effects: IO (Doltgres connect, DDL, tracking-row writes, dolt_commit).
 * Notes: Re-implements drizzle's journal walk via sql.unsafe to dodge Doltgres 0.56 extended-protocol gap on __drizzle_migrations INSERTs.
 * Links: scripts/db/verify-doltgres-schema.mjs (load-bearing post-apply check), docs/spec/databases.md §5.2
 */

// biome-ignore-all lint/suspicious/noConsole: standalone Node script invoked as initContainer CMD; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: container entry point reads DATABASE_URL + NODE_NAME directly; no env wrapper to hide behind

import { readMigrationFiles } from "drizzle-orm/migrator";
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

function sqlEscape(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function isAlreadyExists(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err?.cause instanceof Error ? err.cause.message : "";
  // Narrow to DDL-collision shapes drizzle-kit emits. "X already exists" alone
  // would swallow unrelated drift (e.g. function/type/constraint collisions
  // that may indicate a real bug, not idempotent recovery).
  return /\b(?:table|index|schema|relation|constraint) [^\s]+ already exists/i.test(
    `${msg} ${cause}`
  );
}

// Idempotency for DROP statements: if a forward migration drops something
// that's already gone (replayed after a partial apply, or applied twice),
// Doltgres 0.56 emits "not found" / "does not exist". Doltgres also rejects
// `DROP COLUMN IF EXISTS` (bug.5074) so we can't push idempotency into the
// SQL. Tolerate the miss only when the failing statement is itself a DROP —
// every other "not found" stays a hard error.
function isHarmlessDropMiss(stmt, err) {
  const upper = stmt.toUpperCase().replace(/\s+/g, " ").trim();
  const isDrop =
    /^ALTER TABLE [^ ]+ DROP COLUMN\b/.test(upper) ||
    /^DROP (?:TABLE|INDEX|SCHEMA|CONSTRAINT)\b/.test(upper) ||
    /^ALTER TABLE [^ ]+ DROP CONSTRAINT\b/.test(upper);
  if (!isDrop) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err?.cause instanceof Error ? err.cause.message : "";
  // Doltgres 0.56+ phrases the miss several ways. Empirical: `DROP COLUMN`
  // on an absent column emits `table "..." does not have column "..."`;
  // `DROP INDEX` on a missing index emits `index "..." not found`; standard
  // Postgres `does not exist` covers DROP TABLE / DROP SCHEMA.
  return /(?:does not (?:exist|have column)|not found|no such column|unknown column)/i.test(
    `${msg} ${cause}`
  );
}

/**
 * Apply pending migrations via simple-protocol sql.unsafe — the Doltgres-safe
 * equivalent of `drizzle-orm/postgres-js/migrator`'s `migrate()`. Same journal
 * semantics (skip when `folderMillis <= last_applied`), same SHA-256 hashing,
 * same `drizzle.__drizzle_migrations` tracking table — only the wire protocol
 * differs. Per-statement "already exists" tolerance gives free idempotency
 * across re-runs after a partial-apply crash (Doltgres DDL auto-commits past
 * any rollback, so retries can collide with already-created tables).
 */
async function applyPending(sql, folder) {
  const migrations = readMigrationFiles({ migrationsFolder: folder });

  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
  );

  const rows = await sql.unsafe(
    `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`
  );
  const lastWhen = rows[0]?.created_at != null ? Number(rows[0].created_at) : 0;

  let applied = 0;
  for (const migration of migrations) {
    if (migration.folderMillis <= lastWhen) continue;
    for (const stmt of migration.sql) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        await sql.unsafe(trimmed);
      } catch (err) {
        // Idempotent recovery for CREATE collisions and DROP misses. A prior
        // partial run committed the DDL but failed to record it; replay must
        // not fail loud here. Anything outside these two shapes is real
        // drift and re-thrown. Verifier is the final source of truth.
        if (isAlreadyExists(err)) continue;
        if (isHarmlessDropMiss(trimmed, err)) continue;
        throw err;
      }
    }
    await sql.unsafe(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${sqlEscape(migration.hash)}, ${migration.folderMillis})`
    );
    applied += 1;
  }
  return applied;
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
  const result = await withConnection(async (sql) => {
    const applied = await applyPending(sql, migrationsFolder);
    const verifyResult = await verifyDoltgresSchema(sql, migrationsFolder);
    console.log(
      `✓ ${NODE} schema verified against snapshot ${verifyResult.latestTag} (${verifyResult.tablesChecked} table(s))`
    );
    await sql`SELECT dolt_commit('-Am', 'migration: drizzle-kit batch')`;
    return applied;
  });
  console.log(
    `✅ ${NODE} migrate complete: ${result} migration(s) applied + verified + dolt_commit stamped in ${Date.now() - t0}ms`
  );
} catch (err) {
  console.error(`FATAL(${NODE}): migrate failed:`, err);
  process.exitCode = 1;
}
