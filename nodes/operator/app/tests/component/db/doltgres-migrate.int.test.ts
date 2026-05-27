// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/component/db/doltgres-migrate.int.test.ts`
 * Purpose: Regression test for the Doltgres migrator hardening — exercises
 *   the silent-skip drift gap (drizzle-orm decides "applied?" by `folderMillis`
 *   alone, never by hash) and proves the post-migrate schema verifier closes it.
 *   Three scenarios:
 *     1. Fresh `knowledge_operator` + real migrations dir → migrator succeeds, verifier passes.
 *     2. After a drop-column from the live DB → verifier throws SCHEMA_DRIFT
 *        (this is the bug shape from PR #1343's near-miss: candidate-a stays
 *        on the old shape while the app expects the new one).
 *     3. After a drop-table from the live DB → verifier throws SCHEMA_DRIFT
 *        with the missing-table reason.
 * Scope: Component test — boots `dolthub/doltgresql:latest` via testcontainers.
 *   Runs the actual `migrate-doltgres.mjs` script via `execSync` (not a fake)
 *   so the script's journal walker + verifier wiring is exercised end-to-end.
 * Side-effects: Docker container, sub-process, process.env (DATABASE_URL).
 * Notes: No fixture migration files — uses the real on-disk migrations so the
 *   test stays in sync with whatever the latest snapshot expects. New
 *   migrations land here automatically as soon as they're added to `doltgres-migrations/`.
 * Links: scripts/db/migrate-doltgres.mjs, scripts/db/verify-doltgres-schema.mjs
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo-root-relative paths so this test is portable.
// Test file lives at `nodes/operator/app/tests/component/db/` — 6 levels deep,
// so 6 `..` segments reach the repo root.
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const MIGRATE_SCRIPT = path.resolve(
  REPO_ROOT,
  "scripts/db/migrate-doltgres.mjs"
);
const VERIFY_SCRIPT_URL = new URL(
  `file://${path.resolve(REPO_ROOT, "scripts/db/verify-doltgres-schema.mjs")}`
);
const MIGRATIONS_DIR = path.resolve(
  REPO_ROOT,
  "nodes/operator/app/src/adapters/server/db/doltgres-migrations"
);

const { verifyDoltgresSchema } = (await import(VERIFY_SCRIPT_URL.href)) as {
  verifyDoltgresSchema: (
    sql: ReturnType<typeof postgres>,
    folder: string
  ) => Promise<{ ok: true; latestTag: string; tablesChecked: number }>;
};

const DG_USER = "postgres";
const DG_PASSWORD = "doltgres";
const DG_DB = "knowledge_operator";

describe("doltgres migrator + schema verification", () => {
  let container: StartedTestContainer;
  let baseUrl: string;
  let dbUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer("dolthub/doltgresql:latest")
      .withEnvironment({ DOLTGRES_PASSWORD: DG_PASSWORD })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
          60_000
        )
      )
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    baseUrl = `postgresql://${DG_USER}:${DG_PASSWORD}@${host}:${port}/postgres`;
    dbUrl = `postgresql://${DG_USER}:${DG_PASSWORD}@${host}:${port}/${DG_DB}`;

    // Create the per-node DB. Doltgres uses pg wire so we run via a short-lived
    // postgres.js connection against the bootstrap `postgres` DB. Tolerate
    // re-runs (db may already exist if previous test left it).
    const bootstrap = postgres(baseUrl, { max: 1 });
    try {
      await bootstrap.unsafe(`CREATE DATABASE ${DG_DB}`);
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    } finally {
      await bootstrap.end({ timeout: 5 });
    }
  }, 180_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  it("fresh DB: migrator applies all migrations + verifier passes", async () => {
    // Run the ACTUAL migrator script — same code path as the k8s initContainer.
    const result = execSync(`node ${MIGRATE_SCRIPT} ${MIGRATIONS_DIR}`, {
      env: { ...process.env, DATABASE_URL: dbUrl, NODE_NAME: "operator" },
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(result).toMatch(/schema verified/);
    expect(result).toMatch(/dolt_commit stamped/);

    // Independently confirm via the verifier module against the live DB.
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const { ok, tablesChecked, latestTag } = await verifyDoltgresSchema(
        sql,
        MIGRATIONS_DIR
      );
      expect(ok).toBe(true);
      expect(tablesChecked).toBeGreaterThan(0);
      expect(latestTag).toMatch(/^\d{4}_/);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("drift: drop column from live DB → verifier throws SCHEMA_DRIFT", async () => {
    // Simulate the user's scenario: deployed DB is on an older shape than the
    // migrations on disk expect. We use ALTER ... DROP COLUMN to fabricate the
    // drift instead of needing a separate "old 0001" fixture — same end-state.
    const sql = postgres(dbUrl, { max: 1 });
    try {
      // Pick any non-PK column from a known table. `message` on
      // knowledge_contributions is NOT NULL on the current snapshot, so its
      // absence is unmistakable drift.
      await sql.unsafe(
        `ALTER TABLE knowledge_contributions DROP COLUMN message`
      );

      let thrown: unknown;
      try {
        await verifyDoltgresSchema(sql, MIGRATIONS_DIR);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      const err = thrown as Error & { code?: string; missing?: string[] };
      expect(err.code).toBe("SCHEMA_DRIFT");
      expect(err.missing?.some((m) => m.includes("message"))).toBe(true);

      // Restore for the next test.
      await sql.unsafe(
        `ALTER TABLE knowledge_contributions ADD COLUMN message text NOT NULL DEFAULT ''`
      );
      await sql.unsafe(
        `ALTER TABLE knowledge_contributions ALTER COLUMN message DROP DEFAULT`
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  // Intentionally last: drops `citations` without restoring it. vitest's
  // `sequence: { concurrent: false }` (vitest.doltgres.config.mts) guarantees
  // this runs after the drop-column case and the container tears down after.
  it("drift: drop table from live DB → verifier reports missing table", async () => {
    const sql = postgres(dbUrl, { max: 1 });
    try {
      await sql.unsafe(`DROP TABLE citations`);

      let thrown: unknown;
      try {
        await verifyDoltgresSchema(sql, MIGRATIONS_DIR);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      const err = thrown as Error & { code?: string; missing?: string[] };
      expect(err.code).toBe("SCHEMA_DRIFT");
      expect(err.missing?.some((m) => /citations.*missing/.test(m))).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
