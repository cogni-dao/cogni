// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/check-migrations-immutable`
 * Purpose: Fail-loud CI guard that rejects any modification to a migration file already merged on `origin/main`.
 * Scope: Pure git inspection over each node's `migrations/` and `doltgres-migrations/` dirs; does not connect to a DB, does not run drizzle-kit, does not mutate files.
 * Invariants: applied `.sql` files are byte-frozen; applied `<idx>_snapshot.json` files are byte-frozen; `_journal.json` is append-only.
 * Side-effects: IO (git commands, filesystem reads).
 * Notes: drizzle-orm tracks "applied?" by `folderMillis`, never hash — modified applied migrations silently no-op on deployed DBs.
 * Links: docs/spec/databases.md §2.6, scripts/db/check-journal-when.mjs (companion guard)
 */

// biome-ignore-all lint/suspicious/noConsole: validator script; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: script entry point

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE_REF = process.env.MIGRATIONS_BASE_REF?.trim() || "origin/main";

const MIGRATION_DIR_PATTERN =
  /^nodes\/[^/]+\/app\/src\/adapters\/server\/db\/(?:migrations|doltgres-migrations)\//;
const SQL_PATTERN = /\.sql$/;
const SNAPSHOT_PATTERN = /meta\/[^/]+_snapshot\.json$/;
const JOURNAL_PATTERN = /meta\/_journal\.json$/;

function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

function safeRead(spec) {
  try {
    return execSync(`git show ${spec}`, { encoding: "utf8" });
  } catch (err) {
    throw new Error(
      `Failed to read ${spec} from git: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function tryResolveMergeBase() {
  try {
    return git(`merge-base ${BASE_REF} HEAD`);
  } catch {
    return null;
  }
}

let baseSha = tryResolveMergeBase();
if (!baseSha) {
  // CI checkouts default to fetch-depth: 1 — origin/main isn't known. Try a
  // shallow fetch; bail with actionable error if that also fails.
  const remote = BASE_REF.includes("/") ? BASE_REF.split("/")[0] : "origin";
  const branch = BASE_REF.includes("/")
    ? BASE_REF.split("/").slice(1).join("/")
    : BASE_REF;
  try {
    execSync(`git fetch --no-tags --depth=200 ${remote} ${branch}`, {
      stdio: "ignore",
    });
    baseSha = tryResolveMergeBase();
  } catch {
    // fetch failed too — fall through to error
  }
}
if (!baseSha) {
  console.error(
    `✗ check-migrations-immutable: cannot resolve merge-base with ${BASE_REF}.\n` +
      `  Run \`git fetch origin main\` (or set MIGRATIONS_BASE_REF to a fetched ref).`
  );
  process.exit(2);
}

// Diff against merge-base WITHOUT `...HEAD` so working-tree changes (unstaged
// + staged + committed) are all captured. In CI this collapses to "committed",
// but locally it catches a developer who edited an applied migration without
// staging yet.
const diffOutput = git(`diff --name-status ${baseSha}`);
const lines = diffOutput.split("\n").filter(Boolean);

const violations = [];
let inspected = 0;

for (const line of lines) {
  const [statusRaw, ...rest] = line.split("\t");
  if (!statusRaw) continue;
  const status = statusRaw[0]; // 'M'odified, 'D'eleted, 'A'dded, 'R'enamed, 'C'opied
  // For renames/copies, git emits two paths; we care about the OLD path (rest[0])
  const oldPath = rest[0];
  const newPath = rest[1] ?? rest[0];

  // Match if either path is inside a migrations dir — catches renames OUT of
  // (deletion-equivalent) and renames INTO (introducing a synthetic "applied"
  // migration that bypasses drizzle-kit).
  if (
    !MIGRATION_DIR_PATTERN.test(oldPath) &&
    !MIGRATION_DIR_PATTERN.test(newPath)
  )
    continue;
  inspected += 1;

  if (status === "A") continue; // new files allowed

  if (status === "D") {
    violations.push({
      path: oldPath,
      reason: `deleted (status ${status})`,
    });
    continue;
  }

  if (status === "R" || status === "C") {
    violations.push({
      path: `${oldPath} -> ${newPath}`,
      reason: `${status === "R" ? "renamed" : "copied"} from a committed migration file`,
    });
    continue;
  }

  if (status !== "M") continue;

  // Modified file — allow ONLY if it's _journal.json AND the diff is purely
  // additive (existing entries byte-identical). Everything else is a violation.
  if (JOURNAL_PATTERN.test(oldPath)) {
    const baseJournal = JSON.parse(safeRead(`${baseSha}:${oldPath}`));
    const headJournal = JSON.parse(readFileSync(oldPath, "utf8"));
    const baseEntries = baseJournal.entries ?? [];
    const headEntries = headJournal.entries ?? [];
    if (headEntries.length < baseEntries.length) {
      violations.push({
        path: oldPath,
        reason: `journal shrank from ${baseEntries.length} to ${headEntries.length} entries`,
      });
      continue;
    }
    const driftIdx = baseEntries.findIndex(
      (entry, i) => JSON.stringify(entry) !== JSON.stringify(headEntries[i])
    );
    if (driftIdx !== -1) {
      const baseEntry = baseEntries[driftIdx];
      const headEntry = headEntries[driftIdx];
      violations.push({
        path: oldPath,
        reason:
          `entry idx ${driftIdx} (${baseEntry?.tag ?? "?"}) was modified.\n` +
          `    before: ${JSON.stringify(baseEntry)}\n` +
          `    after:  ${JSON.stringify(headEntry)}\n` +
          `    Existing journal entries are frozen — append new entries only.`,
      });
    }
    continue;
  }

  if (SQL_PATTERN.test(oldPath)) {
    violations.push({
      path: oldPath,
      reason:
        "migration SQL on origin/main was modified.\n" +
        "    drizzle-orm's runtime migrator skips by `when` (folderMillis), never by hash —\n" +
        "    modifying an applied migration silently no-ops on deployed DBs. Add a new\n" +
        "    numbered forward migration (NNNN_<tag>.sql) instead.",
    });
    continue;
  }

  if (SNAPSHOT_PATTERN.test(oldPath)) {
    violations.push({
      path: oldPath,
      reason:
        "snapshot on origin/main was modified.\n" +
        "    Each NNNN_snapshot.json is the frozen end-state baseline drizzle-kit diffs\n" +
        "    against to generate the NEXT migration. Mutating an old snapshot poisons the\n" +
        "    diff chain. If you need new tables/columns, edit the schema TS and run\n" +
        "    `pnpm db:generate:<node>` — drizzle-kit will append a NEW snapshot.",
    });
  }

  // Anything else under the migrations dir (README, etc.) — allow.
}

if (violations.length > 0) {
  console.error(
    `✗ ${violations.length} migration immutability violation(s) (base=${BASE_REF}, merge-base=${baseSha.slice(0, 8)}):\n`
  );
  for (const v of violations) {
    console.error(`  • ${v.path}`);
    console.error(`    ${v.reason}\n`);
  }
  console.error(
    "Migrations are append-only. To change schema, add a new numbered forward migration.\n" +
      "If a committed migration is genuinely wrong and has NOT yet shipped to any\n" +
      "deployed DB, coordinate with the team — the fix is to bump `when` + open a\n" +
      "design discussion, not to silently rewrite the file."
  );
  process.exit(1);
}

console.log(
  `✓ check-migrations-immutable: ${inspected} migration path(s) inspected against ${BASE_REF} — all immutable files untouched.`
);
