// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/migrate`
 * Purpose: Shared Postgres migrator runner invoked as the per-node Deployment initContainer. Wraps drizzle-orm/postgres-js/migrator in a blocking pg_advisory_lock so concurrent initContainers serialize cleanly, then reports what it applied.
 * Scope: Per-node Postgres migrations only. Does not migrate Doltgres (separate script for poly's knowledge plane). Does not run drizzle-kit (CLI is dev-only).
 * Invariants: NODE_NAME + DATABASE_URL from env; argv[2] migrations dir; lock auto-releases on session end; success prints a declared-vs-applied receipt
 * Side-effects: IO (Postgres connect, advisory lock, migrate, read drizzle ledger, unlock).
 * Notes: COPY'd into each runtime image at /app/nodes/<node>/app/migrate.mjs. LOCK_KEY shared safely — advisory locks are database-scoped.
 * Links: docs/spec/databases.md §2 Migration Strategy, nodes/operator/app/src/shared/migrations/migration-receipt.ts (the parser twin), work/items/task.0371.kill-presync-migration-hook-step-1.md
 * @internal
 */

// biome-ignore-all lint/suspicious/noConsole: standalone Node script invoked as initContainer CMD; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: container entry point reads DATABASE_URL + NODE_NAME directly; no env wrapper to hide behind

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const NODE = process.env.NODE_NAME?.trim() || "unknown";

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

/**
 * Receipt marker. TWIN of `MIGRATION_RECEIPT_MARKER` in
 * nodes/operator/app/src/shared/migrations/migration-receipt.ts — this script is COPY'd into each
 * runtime image standalone and may not import it, so the literal is restated and a spec pins both
 * sides. A v2 payload gets a NEW marker rather than a changed shape.
 */
const RECEIPT_MARKER = "COGNI_MIGRATION_RECEIPT_V1";

/** Journal tags this image DECLARES, in journal order, with their `when` for the ledger join. */
function readJournal(folder) {
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8")
  );
  return (journal.entries ?? []).map((entry) => ({
    tag: String(entry.tag),
    when: Number(entry.when),
  }));
}

/**
 * Print the declared-vs-applied receipt for the database this process just migrated.
 *
 * Reads drizzle's OWN ledger (`drizzle.__drizzle_migrations`) with the node's OWN DSN — the one
 * credential that is allowed to see it. The operator collects this line from the migration Job it
 * created; it never connects to this database (docs/spec/multi-node-tenancy.md NO_CROSS_NODE_QUERIES).
 *
 * Best-effort by construction: a receipt is deployment METADATA, and failing to describe a
 * successful migration must never turn it into a failed one.
 */
async function reportReceipt(sqlClient, folder) {
  try {
    const declared = readJournal(folder);
    const byWhen = new Map(declared.map((e) => [e.when, e.tag]));
    const rows = await sqlClient`
      SELECT hash, created_at
        FROM drizzle.__drizzle_migrations
       ORDER BY created_at ASC`;
    const applied = rows.map((row) => {
      const appliedAtMs = Number(row.created_at);
      return {
        tag: byWhen.get(appliedAtMs) ?? `unknown:${appliedAtMs}`,
        hash: String(row.hash),
        appliedAtMs,
      };
    });
    console.log(
      `${RECEIPT_MARKER} ${JSON.stringify({
        node: NODE,
        declared: declared.map((e) => e.tag),
        applied,
      })}`
    );
  } catch (err) {
    // Never fatal, and deliberately loud: a missing receipt means the schema readout will say
    // "never reported" rather than silently implying success.
    console.error(
      `WARN(${NODE}): migration receipt not emitted:`,
      err instanceof Error ? err.message : err
    );
  }
}

// Postgres advisory lock — single-writer guard so concurrent initContainers
// (replicas > 1, HPA scale-out, rolling-update overlap) don't race the same
// migration. Blocking acquire: peer waits, then drizzle's journal makes the
// inner migrate() a no-op when the schema is already current. Lock auto-
// releases on session end; explicit unlock in finally for clarity.
const LOCK_KEY = 0x436f676e6901n;

let sql;
try {
  sql = postgres(url, { max: 1, onnotice: (n) => console.log(n.message) });
  const t0 = Date.now();
  await sql`SELECT pg_advisory_lock(${LOCK_KEY})`;
  try {
    await migrate(drizzle(sql), { migrationsFolder });
    console.log(`✅ ${NODE} migrations applied in ${Date.now() - t0}ms`);
    // Report what landed. Inside the lock, on the same session that proved it.
    await reportReceipt(sql, migrationsFolder);
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  }
} catch (err) {
  console.error(`FATAL(${NODE}): migrate failed:`, err);
  process.exitCode = 1;
} finally {
  if (sql) await sql.end({ timeout: 5 });
}
