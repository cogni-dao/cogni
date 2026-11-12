// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/migrate`
 * Purpose: Shared Postgres migrator runner invoked as the per-node Deployment initContainer. Wraps drizzle-orm/postgres-js/migrator in a blocking pg_advisory_lock so concurrent initContainers serialize cleanly, then reports what it applied.
 * Scope: Per-node Postgres migrations only. Does not migrate Doltgres (separate script for poly's knowledge plane). Does not run drizzle-kit (CLI is dev-only).
 * Invariants: One physical session owns the lock and 0063 guards. SQL and ledger stay immutable. Success follows shutdown.
 * Side-effects: IO (Postgres connect, advisory lock, migrate, read drizzle ledger, unlock).
 * Notes: COPY'd into each runtime image at /app/nodes/<node>/app/migrate.mjs. LOCK_KEY shared safely — advisory locks are database-scoped.
 * Links: docs/spec/databases.md §2 Migration Strategy, nodes/operator/app/src/shared/migrations/migration-receipt.ts (the parser twin), work/items/task.0371.kill-presync-migration-hook-step-1.md
 * @internal
 */

// biome-ignore-all lint/suspicious/noConsole: standalone Node script invoked as initContainer CMD; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: container entry point reads DATABASE_URL + NODE_NAME directly; no env wrapper to hide behind

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

// Fixed protection for exercised destructive history, not a schema verifier.
// The two variants differ only in comments. Never normalize an applied hash.
// https://cognidao.org/work/items/story.5156 (migration-safe-v4)
const AUTHORITY_TAG = "0063_wet_midnight";
const AUTHORITY_WHEN = 1794416513978;
const AUTHORITY_HASHES = new Set([
  "e73dfd033ae61dab25b0d319f25f134f27e1fc802728a9a7c77ac9e1881e4f8d",
  "9a876dd45aa10d71486ea4eae8870a00e2ec0ba38879e2e60b65c5988d355b9c",
]);

function refuse(code) {
  throw Object.assign(new Error(code), { code });
}

function diagnosticCode(error) {
  // Only known Drizzle wrappers may expose a native cause. Never traverse an
  // arbitrary object graph or read SQL/message/detail from either error.
  let cause = error;
  for (let depth = 0; depth < 3 && cause instanceof DrizzleQueryError; depth++)
    cause = cause.cause;
  if (
    cause instanceof postgres.PostgresError &&
    typeof cause.code === "string" &&
    /^[0-9A-Z]{5}$/.test(cause.code)
  )
    return cause.code;
  // Our explicit refusals and direct connection codes keep their existing names.
  return /^[a-zA-Z0-9_]{1,64}$/.test(error?.code ?? "")
    ? error.code
    : "migration_failed";
}

function authorityArtifact(folder) {
  const entries = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8")
  ).entries;
  if (!Array.isArray(entries)) refuse("migration_journal_invalid");
  const targets = entries.filter((entry) => entry.tag === AUTHORITY_TAG);
  if (NODE !== "operator" && targets.length === 0) return null;
  if (
    NODE !== "operator" ||
    targets.length !== 1 ||
    targets[0].when !== AUTHORITY_WHEN
  )
    refuse("migration_authority_artifact_invalid");
  let previous = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.when) || entry.when <= previous)
      refuse("migration_journal_invalid");
    previous = entry.when;
  }
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const byWhen = new Map(migrations.map((m) => [m.folderMillis, m.hash]));
  const hash = byWhen.get(AUTHORITY_WHEN);
  if (!AUTHORITY_HASHES.has(hash)) refuse("migration_authority_hash_unknown");
  return { byWhen, hash, lastWhen: previous };
}

function historyRow(row, artifact) {
  if (
    !/^[0-9]+$/.test(String(row.created_at)) ||
    !Number.isSafeInteger(Number(row.created_at)) ||
    Number(row.created_at) <= 0 ||
    typeof row.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.hash)
  )
    refuse("migration_history_invalid");
  const when = Number(row.created_at);
  if (
    when === AUTHORITY_WHEN
      ? !AUTHORITY_HASHES.has(row.hash)
      : artifact.byWhen.get(when) !== row.hash
  )
    refuse("migration_history_unknown");
  return { when, hash: row.hash };
}

async function authorityHistory(client, artifact) {
  const relation = await client`
    SELECT c.relkind FROM pg_catalog.pg_class c
    WHERE c.oid = pg_catalog.to_regclass('drizzle.__drizzle_migrations')`;
  if (relation.length === 0) return { tip: null, target: null };
  if (relation[0].relkind !== "r") refuse("migration_ledger_not_table");
  // Only decisive rows: tied maximum and duplicate target both refuse.
  const tips = await client`
    SELECT created_at, hash FROM drizzle.__drizzle_migrations
    ORDER BY created_at DESC LIMIT 2`;
  const targets = await client`
    SELECT created_at, hash FROM drizzle.__drizzle_migrations
    WHERE created_at = ${AUTHORITY_WHEN} LIMIT 2`;
  if (
    targets.length > 1 ||
    (tips.length > 1 && tips[0].created_at === tips[1].created_at)
  )
    refuse("migration_history_duplicate");
  const tip = tips.length ? historyRow(tips[0], artifact) : null;
  const target = targets.length ? historyRow(targets[0], artifact) : null;
  if (tip && tip.when >= AUTHORITY_WHEN && !target)
    refuse("migration_authority_row_missing");
  return { tip, target };
}

async function authorityPreflight(client, artifact) {
  // Explicit temp placement prevents implicit temp-first relation lookup;
  // implicit pg_catalog retains builtin priority and public creates objects.
  await client`SET search_path TO public, pg_temp`;
  const [namespace] = await client`SELECT pg_catalog.current_schema() AS name`;
  if (namespace?.name !== "public") refuse("migration_namespace_invalid");
  const before = await authorityHistory(client, artifact);
  if (before.tip && before.tip.when >= AUTHORITY_WHEN) return before;
  const relations = await client`
    SELECT 1 FROM (VALUES ('agent_credentials'), ('agent_principals'), ('agent_roles')) AS wanted(name)
    WHERE pg_catalog.to_regclass(wanted.name) IS NOT NULL LIMIT 1`;
  const functions = await client`
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN
      ('agent_credential_state', 'agent_principals_refuse_wallet_binding', 'agent_credentials_require_external_principal')
    LIMIT 1`;
  const triggers = await client`
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE (t.tgrelid = pg_catalog.to_regclass('user_bindings') AND t.tgname = 'agent_principals_no_wallet_binding')
       OR (t.tgrelid = pg_catalog.to_regclass('agent_credentials') AND t.tgname = 'agent_credentials_external_principal_only')
    LIMIT 1`;
  if (relations.length || functions.length || triggers.length)
    refuse("migration_authority_collision");
  return before;
}

async function authorityPostcheck(client, artifact, before) {
  const after = await authorityHistory(client, artifact);
  if (
    !after.target ||
    after.target.hash !== (before.target?.hash ?? artifact.hash) ||
    after.tip?.when !== artifact.lastWhen
  )
    refuse("migration_authority_postcheck_failed");
}

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
let protectedSession = true;
let locked = false;
let completed = false;
const t0 = Date.now();
try {
  const artifact = authorityArtifact(migrationsFolder);
  sql = postgres(url, {
    max: 1,
    onnotice: (n) => console.log(n.message),
    onclose() {
      if (!protectedSession) return;
      // postgres.js 3.4.7 invokes this SYNCHRONOUSLY before reconnecting
      // queued work. Async end/rejection/exitCode would allow that branch.
      try {
        process.stderr.write("FATAL: migration_session_lost\n");
      } finally {
        process.exit(1);
      }
    },
  });
  await sql`SELECT pg_catalog.pg_advisory_lock(${LOCK_KEY})`;
  locked = true;
  try {
    const before = artifact ? await authorityPreflight(sql, artifact) : null;
    // Actual-runner CI pauses here with the native inspector, never a prod flag.
    await migrate(drizzle(sql), { migrationsFolder });
    if (artifact) await authorityPostcheck(sql, artifact, before);
    // Report what landed. Inside the lock, on the same session that proved it.
    await reportReceipt(sql, migrationsFolder);
  } finally {
    const [released] = await sql`
      SELECT pg_catalog.pg_advisory_unlock(${LOCK_KEY}) AS released`;
    if (released?.released !== true) refuse("migration_unlock_failed");
    locked = false;
  }
  completed = true;
} catch (err) {
  // Driver errors can carry SQL/parameters. Diagnostics carry only a code.
  const code = diagnosticCode(err);
  console.error(`FATAL(${NODE}): ${code}`);
  process.exitCode = 1;
} finally {
  // Never disarm a possibly still-owned lock. No SQL follows planned shutdown.
  if (locked) process.exit(1);
  protectedSession = false;
  if (sql) await sql.end({ timeout: 5 });
}
if (completed)
  console.log(`✅ ${NODE} migrations applied in ${Date.now() - t0}ms`);
