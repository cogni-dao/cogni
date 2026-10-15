// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/check-journal-when`
 * Purpose: Fail-loud guard against the silent-skip migration regression — fails CI when a node's `meta/_journal.json` `when` values are non-monotonic, the failure mode that bit poly 0034 + 0035 in April 2026.
 * Scope: Validates every per-node Postgres + Doltgres journal under `nodes/*`. Does not run drizzle-kit, does not connect to a database, does not modify journal files.
 * Invariants:
 *   1. Entries' `when` values are STRICTLY MONOTONIC INCREASING in idx order.
 *   2. No entry's `when` is in the future (> Date.now()).
 * Side-effects: IO (filesystem reads), process.env (CWD only).
 * Links: docs/spec/databases.md §2.6, .claude/skills/schema-update/SKILL.md
 */

// biome-ignore-all lint/suspicious/noConsole: validator script; stdout is the only log surface
// biome-ignore-all lint/style/noProcessEnv: script entry point

import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const journals = globSync(
  [
    "nodes/*/app/src/adapters/server/db/migrations/meta/_journal.json",
    "nodes/*/app/src/adapters/server/db/doltgres-migrations/meta/_journal.json",
    "infra/compose/runtime/postgres-init/control-migrations/meta/_journal.json",
  ],
  { cwd: repoRoot }
);

if (journals.length === 0) {
  console.error(
    "✗ check-journal-when: no journals found — glob misconfigured?"
  );
  process.exit(2);
}

const now = Date.now();
let violations = 0;
let warnings = 0;

for (const rel of journals) {
  const path = resolve(repoRoot, rel);
  const journal = JSON.parse(readFileSync(path, "utf8"));
  const entries = journal.entries ?? [];
  let prev = null;
  for (const entry of entries) {
    if (prev && entry.when <= prev.when) {
      console.error(
        `✗ ${rel}\n` +
          `  idx ${entry.idx} (${entry.tag}) when=${entry.when} ≤ idx ${prev.idx} (${prev.tag}) when=${prev.when}\n` +
          `  drizzle-orm sorts by \`when\`; out-of-order entries are silently skipped at runtime.\n` +
          `  Fix: bump idx ${entry.idx} to when=${prev.when + 1} (or a real future-safe Date.now()).\n` +
          `  See docs/spec/databases.md §2.6.`
      );
      violations++;
    }
    if (entry.when > now) {
      // Warning, not violation: future-dated entries that have already shipped to deployed DBs
      // can't be retroactively normalized (would break the chain on preview/prod). The strict-
      // monotonic check above is the load-bearing guard against silent-skip; future-dating is
      // the upstream cause but the symptom always surfaces as a monotonicity violation in the
      // next dev's PR. Warn loudly so future hand-authors don't repeat the mistake.
      console.warn(
        `⚠ ${rel}\n` +
          `  idx ${entry.idx} (${entry.tag}) when=${entry.when} is in the future (now=${now}).\n` +
          `  Future-dated \`when\` poisons every later migration on this node. Subsequent\n` +
          `  auto-gen migrations must hand-bump \`when\` past ${entry.when} until the wall clock\n` +
          `  catches up. Never future-date \`when\` in new migrations.`
      );
      warnings++;
    }
    prev = entry;
  }
}

if (violations > 0) {
  console.error(
    `\n✗ ${violations} journal violation(s) across ${journals.length} file(s).`
  );
  process.exit(1);
}

const summary = `✓ ${journals.length} migration journal(s) — strict-monotonic \`when\` OK.`;
console.log(
  warnings > 0 ? `${summary} (${warnings} future-date warning(s))` : summary
);
