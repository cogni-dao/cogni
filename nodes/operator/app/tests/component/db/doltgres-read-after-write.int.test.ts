// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/component/db/doltgres-read-after-write.int.test.ts`
 * Purpose: Hold the knowledge plane's read-after-write invariant across the SPLIT clients bug.5391 introduced — a write committed through the dedicated `max: 1` branch client must be visible to the very next read on the long-lived pooled read client.
 * Scope: Component test — boots the pinned production Doltgres image and wires TWO long-lived clients exactly as `bootstrap/container.ts` does. Does not exercise HTTP routes, auth, the contribution service's policy gates, or anything above the adapter.
 * Invariants:
 *   - TWO long-lived clients, warmed BEFORE the write. The sibling int tests
 *     build fresh clients per call and are therefore structurally blind to
 *     pooled-session staleness; this file exists to remove that blind spot.
 *   - Every pooled connection is exercised after the write, not just whichever
 *     one postgres.js happens to hand out first. Reads are issued concurrently
 *     (`READ_POOL_MAX * 2`) so all five sessions answer.
 *   - RED CONTROL first (same convention as the sibling concurrency test): a
 *     deliberately pinned session must be seen to lag, or a green here would
 *     only mean the probe is blind.
 *   - The decisive assertion is on `dolt_hashof('main')`, not only on row
 *     visibility: a session that has pinned an older working-set/HEAD view
 *     reports an older hash, which is the root signal rather than a symptom.
 *
 * WHY THIS FILE IS GREEN ON ARRIVAL — bug.5413's stated mechanism is DISPROVEN.
 *
 * bug.5413 proposed that, because bug.5391 gave branch work its own client, the
 * read pool's long-lived sessions keep serving an older `main` and never observe
 * commits made through the branch client. That is a falsifiable claim about
 * Doltgres session semantics, and against `dolthub/doltgresql:0.57.3` — the
 * version production and candidate-a actually run — it is false:
 *
 *   - All five pre-warmed read sessions report the branch client's NEW
 *     `dolt_hashof('main')` on the first read after the commit, at t+0.
 *   - They also see the row at t+0, t+1s, t+5s and t+35s (i.e. across the
 *     `idle_timeout: 30` recycle boundary the bug blamed for recovery).
 *   - A read session's view is not disturbed while the branch session is
 *     checked out to a `contrib/*` branch; `active_branch()` stays `main`.
 *
 * So a Doltgres session does NOT pin a HEAD view across autocommit statements,
 * and the pool split cannot by itself hide a committed row. The production 404s
 * recorded in bug.5413 have some other cause; this file is kept as the standing
 * regression guard for the invariant, so the hypothesis cannot be re-proposed
 * without evidence and so a future engine upgrade or pool change that DOES
 * introduce session-pinned staleness fails here instead of in production.
 * Side-effects: Docker container, sub-process (migrator), database writes.
 * Links: packages/knowledge-store/src/adapters/doltgres/build-client.ts, packages/knowledge-store/src/adapters/doltgres/session-admission.ts
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDoltgresClient,
  DoltgresKnowledgeContributionAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import postgres, { type Sql } from "postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const MIGRATE_SCRIPT = path.resolve(
  REPO_ROOT,
  "scripts/db/migrate-doltgres.mjs"
);
const MIGRATIONS_DIR = path.resolve(
  REPO_ROOT,
  "nodes/operator/app/src/adapters/server/db/doltgres-migrations"
);

/**
 * Pinned to the version production and candidate-a actually run
 * (`infra/compose/runtime/docker-compose.yml`), not `:latest`. Session-visibility
 * semantics are engine behaviour, so a floating tag could hide or manufacture
 * this bug. `tests/external/dolthub/knowledge-roundtrip.external.test.ts` pins
 * the same way.
 */
const DOLTGRES_IMAGE = "dolthub/doltgresql:0.57.3";

const DG_USER = "postgres";
const DG_PASSWORD = "doltgres";
const DG_DB = "knowledge_operator";

/** Mirrors `buildDoltgresClient`'s default — the pool size production reads on. */
const READ_POOL_MAX = 5;

/** Registered on a committed `main` in `beforeAll` so contrib branches inherit it. */
const SEED_DOMAIN = "read-after-write";

const principal = (name: string) => ({
  id: `agent:${name}`,
  kind: "agent" as const,
  name,
});

describe("knowledge read-after-write across the split clients (bug.5413)", () => {
  let container: StartedTestContainer;
  let dbUrl: string;
  let readClient: Sql;
  let branchClient: Sql;
  let adapter: DoltgresKnowledgeContributionAdapter;

  beforeAll(async () => {
    container = await new GenericContainer(DOLTGRES_IMAGE)
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
    const baseUrl = `postgresql://${DG_USER}:${DG_PASSWORD}@${host}:${port}/postgres`;
    dbUrl = `postgresql://${DG_USER}:${DG_PASSWORD}@${host}:${port}/${DG_DB}`;

    const bootstrap = postgres(baseUrl, { max: 1 });
    try {
      await bootstrap.unsafe(`CREATE DATABASE ${DG_DB}`);
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    } finally {
      await bootstrap.end({ timeout: 5 });
    }

    execSync(`node ${MIGRATE_SCRIPT} ${MIGRATIONS_DIR}`, {
      env: { ...process.env, DATABASE_URL: dbUrl, NODE_NAME: "operator" },
      encoding: "utf8",
      stdio: "pipe",
    });

    // Seed the domain on a COMMITTED main, so a contrib branch cut from main's
    // HEAD passes `assertDomainRegistered`. Done on a throwaway client that is
    // closed again, so neither long-lived client has ever written.
    // `max: 1` keeps every statement on one session without `reserve()` — a
    // cold reserve on a `fetch_types: false` client never settles (bug.5386).
    const seed = buildDoltgresClient({ connectionString: dbUrl, max: 1 });
    try {
      await seed.unsafe(`SELECT dolt_checkout('main')`);
      await seed.unsafe(
        `INSERT INTO domains (id, name, description) VALUES ('${SEED_DOMAIN}', 'read after write', 'bug.5413 fixture')`
      );
      await seed.unsafe(`SELECT dolt_commit('-Am', 'seed domain fixture')`);
    } finally {
      await seed.end({ timeout: 5 });
    }

    // EXACTLY the container.ts wiring: a default-max pooled read client and a
    // separate `max: 1` branch client. Both long-lived for the whole file.
    readClient = buildDoltgresClient({
      connectionString: dbUrl,
      applicationName: "cogni_knowledge_test",
    });
    const createBranchClient = () =>
      buildDoltgresClient({
        connectionString: dbUrl,
        applicationName: "cogni_knowledge_branch_test",
        max: 1,
      });
    branchClient = createBranchClient();
    adapter = new DoltgresKnowledgeContributionAdapter({
      sql: readClient,
      branchSql: branchClient,
      recreateBranchClient: createBranchClient,
    });

    // Warm every pooled session so the read path is served by connections that
    // were established BEFORE any write — the production steady state.
    await Promise.all(
      Array.from({ length: READ_POOL_MAX }, () =>
        readClient.unsafe("SELECT count(*) AS n FROM knowledge_contributions")
      )
    );
  }, 240_000);

  afterAll(async () => {
    await readClient?.end({ timeout: 5 }).catch(() => undefined);
    await branchClient?.end({ timeout: 5 }).catch(() => undefined);
    if (container) await container.stop();
  });

  it("RED CONTROL: the harness does detect a session that pinned its view", async () => {
    // Without this, every green below could mean "the probe cannot see
    // staleness" rather than "there is none". An EXPLICIT transaction is the
    // one construct that genuinely pins a Doltgres session's view, so it is
    // used here as a known-bad session to prove the assertions have teeth.
    //
    // It is also the measurement that disproves bug.5413: the read path never
    // opens an explicit transaction, and WITHOUT one the same session observes
    // the write immediately (the cases that follow).
    const pinned = buildDoltgresClient({ connectionString: dbUrl, max: 1 });
    try {
      await pinned.unsafe("SELECT 1");
      await pinned.unsafe("BEGIN");
      await pinned.unsafe("SELECT count(*) AS n FROM knowledge_contributions");

      const created = await adapter.create({
        principal: principal("pinned"),
        message: "written while a session holds an open transaction",
      });

      const rows = await pinned.unsafe(
        `SELECT count(*) AS n FROM knowledge_contributions WHERE id = '${created.contributionId}'`
      );
      const seenByPinnedSession = Number(
        (rows[0] as Record<string, unknown>).n
      );
      await pinned.unsafe("ROLLBACK");

      // The pooled read client, which holds no transaction, sees it at once.
      const pooled = await adapter.getById(created.contributionId);
      expect(pooled?.contributionId).toBe(created.contributionId);

      // Teeth: the pinned session is measurably behind the pooled one. If this
      // ever stops being true the probe has lost its ability to detect
      // staleness at all, and the greens below become meaningless.
      expect(
        seenByPinnedSession,
        "harness cannot detect a pinned session — the greens below prove nothing"
      ).toBe(0);
    } finally {
      await pinned.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 120_000);

  it("a just-created contribution is visible on EVERY warmed read session", async () => {
    const created = await adapter.create({
      principal: principal("rawreader"),
      message: "read-after-write on a warmed pool",
    });

    // Concurrent so postgres.js spreads the reads across all pooled sessions;
    // a sequential loop would keep landing on the same connection.
    const seen = await Promise.all(
      Array.from({ length: READ_POOL_MAX * 2 }, () =>
        adapter.getById(created.contributionId)
      )
    );
    for (const row of seen) {
      expect(
        row,
        "pooled read session served a stale main HEAD"
      ).not.toBeNull();
      expect(row?.contributionId).toBe(created.contributionId);
    }
  }, 120_000);

  it("a just-appended commit is visible on EVERY warmed read session", async () => {
    const created = await adapter.create({
      principal: principal("appender"),
      message: "append then read",
    });
    await adapter.appendCommit({
      contributionId: created.contributionId,
      principal: principal("appender"),
      message: "second logical commit",
      edits: [
        {
          op: "insert",
          entry: {
            id: `${created.contributionId}-entry`,
            domain: SEED_DOMAIN,
            title: "read-after-write probe",
            content: "Proves the append is visible to the pooled read client.",
          },
        },
      ],
    });

    const seen = await Promise.all(
      Array.from({ length: READ_POOL_MAX * 2 }, () =>
        adapter.listCommits(created.contributionId)
      )
    );
    for (const commits of seen) {
      expect(
        commits.length,
        "pooled read session served a stale commit list"
      ).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  it("every warmed read session reports the branch client's new main HEAD", async () => {
    // The root signal. Row visibility is downstream of this: if a pooled
    // session had pinned an older working-set/HEAD view, its `dolt_hashof`
    // would lag the branch client's even when the row happens to be readable.
    const headOf = async (sql: Sql) => {
      const rows = await sql.unsafe(`SELECT dolt_hashof('main') AS h`);
      return String(Object.values(rows[0] as Record<string, unknown>)[0]);
    };
    const before = await headOf(branchClient);
    await adapter.create({
      principal: principal("headwatcher"),
      message: "advance main HEAD",
    });
    const after = await headOf(branchClient);
    expect(after, "create did not advance main HEAD").not.toBe(before);

    const heads = await Promise.all(
      Array.from({ length: READ_POOL_MAX * 2 }, () => headOf(readClient))
    );
    for (const head of heads) {
      expect(head, "pooled read session pinned an older main HEAD").toBe(after);
    }
  }, 120_000);

  it("the raw pooled client sees the row too, not just the adapter", async () => {
    const created = await adapter.create({
      principal: principal("rawpool"),
      message: "raw pooled visibility",
    });
    const counts = await Promise.all(
      Array.from({ length: READ_POOL_MAX * 2 }, () =>
        readClient.unsafe(
          `SELECT count(*) AS n FROM knowledge_contributions WHERE id = '${created.contributionId}'`
        )
      )
    );
    for (const rows of counts) {
      const n = Number((rows[0] as Record<string, unknown>).n);
      expect(n, "raw pooled session served a stale main HEAD").toBe(1);
    }
  }, 120_000);
});
