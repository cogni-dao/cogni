// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/migrate-doltgres`
 * Purpose: Shared Doltgres migrator — Doltgres analogue of `scripts/db/migrate.mjs`. Each node's runtime image COPYs this script alongside its own `doltgres-migrations/` dir.
 * Scope: Read-only verification when applied; otherwise shared-guard operation-branch migration. No seeds or database provisioning.
 * Invariants: NODE_NAME + DATABASE_URL from env; argv[2] = migrations dir; verifier throws SCHEMA_DRIFT on shape drift.
 * Side-effects: IO (Doltgres connect, DDL, tracking-row writes, dolt_commit).
 * Notes: Re-implements drizzle's journal walk via sql.unsafe to dodge Doltgres 0.56 extended-protocol gap on __drizzle_migrations INSERTs.
 * Links: scripts/db/verify-doltgres-schema.mjs (load-bearing post-apply check), docs/spec/databases.md §5.2
 */

// biome-ignore-all lint/suspicious/noConsole: standalone Node script invoked as initContainer CMD; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: container entry point reads DATABASE_URL + NODE_NAME directly; no env wrapper to hide behind

import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createHash } from "node:crypto";
import { DoltNativeSessionExecutor, DoltBranchMutationUncertainError, runDoltBranchMutation } from "@cogni-dao/doltgres-admission";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

import { verifyDoltgresSchema } from "./verify-doltgres-schema.mjs";

const NODE = `${process.env.NODE_NAME?.trim() || "unknown"}-doltgres`;

const url = process.env.DATABASE_URL?.trim();

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

const retainedPools = new WeakSet();

function terminateMigration(error) {
  const text = (value) => typeof value === "string" ? value : null;
  writeSync(2, `MIGRATION_OUTCOME ${JSON.stringify({
    code: text(error?.code) ?? (error instanceof DoltBranchMutationUncertainError ? "migration_write_outcome_unknown" : "migration_failed"),
    retryable: error?.retryable === true,
    operationId: text(error?.operationId), branch: text(error?.branch),
    commitHash: text(error?.commitHash), reason: text(error?.reason),
  })}\n`);
  process.exit(1);
}

async function withConnection(fn) {
  if (!url) throw new Error("DATABASE_URL is required");
  const sql = postgres(url, {
    max: 1,
    onnotice: (n) => console.log(n.message),
  });
  try {
    return await fn(sql);
  } finally {
    if (!retainedPools.has(sql)) await sql.end({ timeout: 5 });
  }
}

/** One-time operator cutover: native absence precedes any migrator write. */
export async function auditOperatorProducerDrain(sql) {
  if (process.env.NODE_NAME !== "operator")
    throw new Error("operator_drain_identity_mismatch");
  const declared = decodeURIComponent(new URL(url).pathname.slice(1));
  if (declared !== "knowledge_operator")
    throw new Error("operator_drain_database_mismatch");
  return auditDoltProducerDrain(sql, declared);
}

/**
 * Internal native audit for a runner-verified owning-node maintenance boundary.
 * expectedDatabase comes from the immutable catalog slug's canonical normalizer,
 * never an HTTP database/DSN argument. Generic CLI derives this identity from NODE_NAME plus the actual DSN; owning runners use the same canonical normalizer.
 */
export async function auditDoltProducerDrain(sql, expectedDatabase) {
  if (
    typeof expectedDatabase !== "string" ||
    !/^knowledge_[a-z0-9_]+$/.test(expectedDatabase)
  )
    throw new Error("operator_drain_database_mismatch");
  const declared = expectedDatabase;
  const [identity] = await sql.unsafe(
    "SELECT current_database() AS database, pg_backend_pid() AS pid, version() AS version"
  );
  const pid = Number(identity?.pid);
  if (
    identity?.database !== declared ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    identity?.version !== "PostgreSQL 15.5"
  )
    throw new Error("operator_drain_native_identity_unproven");
  const absent = async () => {
    const sessions = await sql.unsafe(
      "SELECT pid, datname FROM pg_catalog.pg_stat_activity"
    );
    if (!sessions.some((session) => Number(session.pid) === pid))
      throw new Error("operator_drain_processlist_unproven");
    const other = sessions.filter((session) => {
      if (Number(session.pid) === pid) return false;
      return (
        !session.datname ||
        session.datname === declared ||
        String(session.datname).startsWith(`${declared}/`)
      );
    });
    if (other.length)
      throw new Error("operator_drain_native_producers_present");
  };
  await absent();
  const branches = await sql.unsafe("SELECT name FROM dolt.branches");
  if (branches.filter((branch) => branch.name === "main").length !== 1)
    throw new Error("operator_drain_main_identity_unproven");
  await sql.unsafe("SELECT dolt_checkout('main')");
  const [head] = await sql.unsafe("SELECT dolt_hashof('HEAD') AS hash");
  const hash = Array.isArray(head?.hash) ? head.hash[0] : head?.hash;
  if (typeof hash !== "string" || !/^[a-z0-9]{32,64}$/i.test(hash))
    throw new Error("operator_drain_head_unproven");
  if ((await sql.unsafe("SELECT * FROM dolt.status")).length)
    throw new Error("operator_drain_main_dirty");
  const merge = await sql.unsafe("SELECT is_merging FROM dolt.merge_status");
  if (
    merge.length !== 1 ||
    ![false, "false", 0].includes(merge[0]?.is_merging) ||
    (await sql.unsafe("SELECT * FROM dolt.conflicts")).length
  )
    throw new Error("operator_drain_merge_or_conflict_unproven");
  await absent();
  console.log(
    "OPERATOR_NATIVE_DRAIN",
    JSON.stringify({
      database: declared,
      pid,
      pgCompatibilityVersion: identity.version,
      branches: branches.map((branch) => branch.name),
      mainHead: hash,
      otherNativeSessions: 0,
      mainDirty: false,
    })
  );
}

// Read the existing journal without creating a schema/table or touching MAIN.
async function pendingCount(sql, folder) {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const exists = await sql.unsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'"
  );
  if (!exists.length) return migrations.length;
  const rows = await sql.unsafe(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1"
  );
  const lastWhen = rows[0]?.created_at != null ? Number(rows[0].created_at) : 0;
  return migrations.filter((migration) => migration.folderMillis > lastWhen)
    .length;
}

function owningKnowledgeDatabase() {
  const slug = process.env.NODE_NAME?.trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug ?? ""))
    throw new Error("migration_node_identity_unproven");
  const base = `knowledge_${slug.replaceAll("-", "_")}`;
  const declared = decodeURIComponent(new URL(url).pathname.slice(1));
  // The owning migration Secret may project a foreign-custodied lane onto
  // the control engine. Its canonical namespace retains that lane's suffix.
  // This checks the node namespace, not lane authorization: current Jobs carry
  // NODE_NAME + the trusted Secret DSN, not DEPLOY_ENVIRONMENT/control custody.
  const allowed = [base, ...["candidate_a", "preview", "production"].map((lane) => `${base}_${lane}`)];
  if (!allowed.includes(declared))
    throw Object.assign(new Error("migration_database_identity_mismatch"), {
      code: "migration_database_identity_mismatch", retryable: false,
    });
  return declared;
}

async function migrate(folder, before) {
  if (!folder) throw new Error("migrations dir is required");
  const expectedDatabase = owningKnowledgeDatabase();
  const t0 = Date.now();
  const result = await withConnection(async (pool) => {
    await pool.unsafe("SELECT 1");
    const reader = await pool.reserve();
    let pending;
    try {
      // Already-applied startup is a reader, even beside an old dirty writer.
      pending = await pendingCount(reader, folder);
      if (pending === 0) {
        if (before) await before(reader);
        await verifyDoltgresSchema(reader, folder);
        return { applied: 0, committed: false };
      }
    } finally { reader.release(); }
    const batch = readMigrationFiles({ migrationsFolder: folder }).map(({ hash, folderMillis }) => ({ hash, folderMillis }));
    const operationId = `migration.${expectedDatabase}.${createHash("sha256").update(JSON.stringify(batch)).digest("hex")}`;
    const errors = {
      busy: (message) => Object.assign(new Error(message), { code: "migration_writer_busy", retryable: true }),
      fault: (message) => Object.assign(new Error(message), { code: "migration_scope_fault", retryable: false }),
      outcomeUnknown: (id, branch, commitHash) => Object.assign(new Error("migration outcome requires canonical journal/branch inspection"), {
        code: "migration_write_outcome_unknown", retryable: false, operationId: id, branch, commitHash: commitHash ?? null,
      }),
    };
    const executor = new DoltNativeSessionExecutor(pool, { errors, writerProtocol: "database" });
    // First legacy→database activation requires real maintenance source/native
    // drain; fresh birth requires no prior producer. Thereafter the durable
    // delivery floor excludes old writers and every mutation shares this key.
    try {
      return await executor.run(operationId, async (sql, guard, owner) => {
        const [identity] = await sql.unsafe("SELECT current_database() AS database");
        if (identity?.database !== expectedDatabase) throw new Error("migration_database_identity_mismatch");
        if (before) await before(sql);
        // Another admitted migrator may have finished while this one queued.
        if ((await pendingCount(sql, folder)) === 0) {
          await verifyDoltgresSchema(sql, folder);
          return { applied: 0, committed: false };
        }
        const result = await runDoltBranchMutation(sql, {
          guard, operationId, message: "migration: drizzle-kit batch",
          onSessionUncertain: (error) => executor.retire(sql, error),
          onReconcile: owner.registerReconciliation,
          onCommitted: owner.committed,
          run: async (scoped) => {
            const applied = await applyPending(scoped, folder);
            await verifyDoltgresSchema(scoped, folder);
            return { applied, committed: true };
          },
        });
        return result.value;
      }, { operationId, awaitSettlement: true });
    } catch (error) {
      // Keep the executor's session intact. Only the actual runtime entry exits;
      // native socket-death settlement retains the DB guard until work settles.
      retainedPools.add(pool);
      throw error;
    }
  });
  console.log(`✅ ${NODE} migrate complete: ${result.applied} migration(s) applied + verified + ${result.committed ? "owned branch committed" : "read-only no-op; no journal DDL or commit"} in ${Date.now() - t0}ms`);
  return result;
}

/** Runtime init uses the same owner/guard realm as ordinary repaired writers. */
export async function migrateDoltgres(folder) {
  return migrate(folder);
}

// Only the three operator overlay declarations call this one-time entry.
// Generic fork/node CLI migration never opts into owner cutover authority.
export async function migrateOperatorAfterNativeDrain(folder) {
  // Covers connection, prime and reserve, not only SQL after acquisition.
  const deadline = setTimeout(() => {
    console.error("operator_drain_native_audit_deadline");
    process.exit(1);
  }, 90_000);
  try {
    await migrate(folder, async (sql) => {
      await auditOperatorProducerDrain(sql);
      clearTimeout(deadline);
    });
  } catch (error) {
    // This export is the explicit operator init entry, not a general library API.
    terminateMigration(error);
  } finally {
    clearTimeout(deadline);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!url) {
    console.error(`FATAL(${NODE}): DATABASE_URL is required`);
    process.exit(2);
  }
  if (!process.argv[2]) {
    console.error(`FATAL(${NODE}): argv[2] migrations dir is required`);
    process.exit(2);
  }
  try {
    await migrateDoltgres(process.argv[2]);
  } catch (err) {
    terminateMigration(err);
  }
}
