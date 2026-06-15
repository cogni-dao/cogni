// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/check-generate-clean`
 * Purpose: Fail-loud CI guard proving `drizzle-kit generate` produces NO drift — i.e. the
 *          committed migration snapshot baseline exactly matches the schema TS. This is the
 *          gate that makes "edit schema TS -> db:generate -> commit" a clean, safe forward path.
 * Scope: Runs drizzle-kit generate for operator with stdin closed; does not connect to a DB, apply migrations, or leave artifacts behind.
 *        Passes only on a clean "No schema changes" exit-0 with zero new files. Any drift (new
 *        migration, modified journal, or a non-zero/aborted run such as a rename prompt) fails and is reverted.
 * Invariants: never leaves generated artifacts behind; never connects to a DB (generate is a
 *             pure schema-vs-snapshot diff — DATABASE_URL is a dummy, matching db:check:operator).
 * Side-effects: IO (spawns drizzle-kit, reads/writes the migrations dir transiently, git restore).
 * Links: docs/spec/databases.md §2.6, scripts/db/check-migrations-immutable.mjs (companion guard).
 */

// biome-ignore-all lint/suspicious/noConsole: validator script; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: script entry point

import { execFileSync, execSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";

const CONFIG = "nodes/operator/drizzle.config.ts";
const MIG = "nodes/operator/app/src/adapters/server/db/migrations";

function snapshotDir() {
  return {
    sql: new Set(readdirSync(MIG).filter((f) => f.endsWith(".sql"))),
    meta: new Set(
      readdirSync(`${MIG}/meta`).filter(
        (f) => f.endsWith(".json") && f !== "_journal.json"
      )
    ),
  };
}

function restore(newSql, newMeta) {
  for (const f of newSql) {
    rmSync(`${MIG}/${f}`, { force: true });
  }
  for (const f of newMeta) {
    rmSync(`${MIG}/meta/${f}`, { force: true });
  }
  try {
    execSync(`git checkout -- ${MIG}/meta/_journal.json`, { stdio: "ignore" });
  } catch {
    /* journal unchanged */
  }
}

const before = snapshotDir();
let exitZero = true;
let output = "";
try {
  output = execFileSync(
    "tsx",
    ["node_modules/drizzle-kit/bin.cjs", "generate", `--config=${CONFIG}`],
    {
      // stdin ignored: a drift-induced rename prompt hits EOF and aborts (non-zero) instead of hanging.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: "postgres://check@localhost:0/check",
      },
      encoding: "utf8",
    }
  );
} catch (err) {
  exitZero = false;
  output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}

const after = snapshotDir();
const newSql = [...after.sql].filter((f) => !before.sql.has(f));
const newMeta = [...after.meta].filter((f) => !before.meta.has(f));
const clean =
  exitZero &&
  newSql.length === 0 &&
  newMeta.length === 0 &&
  /No schema changes/.test(output);

if (clean) {
  console.log(
    "✓ check-generate-clean: db:generate:operator produces no drift — schema TS matches the snapshot baseline."
  );
  process.exit(0);
}

console.error(
  "✗ check-generate-clean: db:generate:operator is NOT clean — schema TS has drifted from the committed snapshot baseline."
);
for (const f of newSql) {
  console.error(`\n--- drizzle would generate ${f} ---`);
  try {
    console.error(readFileSync(`${MIG}/${f}`, "utf8"));
  } catch {
    /* already gone */
  }
}
if (!exitZero && newSql.length === 0) {
  console.error(
    "\ndrizzle-kit generate exited non-zero (likely a rename prompt from real drift). Output:\n" +
      output.slice(-2000)
  );
}
restore(newSql, newMeta);
console.error(
  "\nFix: run `pnpm db:generate:operator`, review the migration, and commit it (.sql + snapshot + journal). See the schema-update skill."
);
process.exit(1);
