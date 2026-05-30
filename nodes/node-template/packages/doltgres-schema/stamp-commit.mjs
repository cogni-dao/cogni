// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
//
// Post-migrate hook: stamp a named Dolt commit so `dolt_log` is an auditable
// migration trail. Required because DDL in Dolt doesn't auto-commit to the
// working set per dolthub/dolt#4843. Runs inside the node-template migrator
// image immediately after `drizzle-kit migrate` (see package.json
// db:migrate:node-template:doltgres:container). Tolerates only the idempotent
// "nothing to commit" case; any other error exits non-zero.
//
// Intentionally .mjs (not .ts) so the migrator image can invoke it with plain
// `node` — no tsx / drizzle-kit hop. postgres is already in node_modules
// via @cogni/knowledge-store.
//
// Ships as part of @cogni/node-template-doltgres-schema (copied in full by the
// node-template migrator Dockerfile). Not tree-shaken by tsup because it's not
// an entry.

import postgres from "postgres";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("[stamp-commit] DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(url, { max: 1, fetch_types: false, idle_timeout: 5 });

const message =
  process.env.DOLT_COMMIT_MESSAGE?.trim() || "migration: drizzle-kit batch";

try {
  const rows = await sql.unsafe(
    `SELECT dolt_commit('-Am', '${message.replace(/'/g, "''")}') AS hash`,
  );
  const hash = rows?.[0]?.hash;
  console.log(`[stamp-commit] ok: ${JSON.stringify(hash)}`);
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/nothing to commit/i.test(msg)) {
    console.log("[stamp-commit] nothing to commit (idempotent re-run)");
    process.exit(0);
  }
  console.error(`[stamp-commit] FAIL: ${msg}`);
  process.exit(1);
} finally {
  await sql.end({ timeout: 2 });
}
