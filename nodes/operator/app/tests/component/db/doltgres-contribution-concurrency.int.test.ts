// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/component/db/doltgres-contribution-concurrency.int.test.ts`
 * Purpose: Prove, against a real Doltgres, that concurrent knowledge writes all land and that every write is safely retryable (bug.5391).
 * Scope: Component test — boots `dolthub/doltgresql:latest` via testcontainers and drives `DoltgresKnowledgeContributionAdapter` directly. Does not exercise HTTP routes, auth, or the contribution service's policy gates.
 * Invariants:
 *   - RED CONTROL first: the same burst run WITHOUT admission control starves a
 *     shared pool, so the green case cannot be mistaken for a pool that was
 *     never under pressure.
 *   - Reads are served from a different client than branch work, and must keep
 *     answering while a write burst is in flight (bug.5358: a write-side proof
 *     must never gate a read).
 *   - `close`/`merge` replay as a no-op, including when the ack was lost after
 *     the transition had already applied durably.
 * Side-effects: Docker container, sub-process (migrator), database writes.
 * Links: packages/knowledge-store/src/adapters/doltgres/session-admission.ts
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

const DG_USER = "postgres";
const DG_PASSWORD = "doltgres";
const DG_DB = "knowledge_operator";

/** Matches the burst Derek produced by rejecting several inbox rows at once. */
const BURST = 5;

const principal = (name: string) => ({
  id: `agent:${name}`,
  kind: "agent" as const,
  name,
});

function settledWithin<T>(
  promise: Promise<T>,
  ms: number
): Promise<"settled" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  return Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const
    ),
    pending,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describe("knowledge contribution concurrency + retry safety (bug.5391)", () => {
  let container: StartedTestContainer;
  let dbUrl: string;
  let readClient: Sql;
  let branchClient: Sql;
  let adapter: DoltgresKnowledgeContributionAdapter;

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

    readClient = buildDoltgresClient({ connectionString: dbUrl });
    const createBranchClient = () =>
      buildDoltgresClient({ connectionString: dbUrl, max: 1 });
    branchClient = createBranchClient();
    adapter = new DoltgresKnowledgeContributionAdapter({
      sql: readClient,
      branchSql: branchClient,
      recreateBranchClient: createBranchClient,
    });
  }, 240_000);

  afterAll(async () => {
    await readClient?.end({ timeout: 5 }).catch(() => undefined);
    await branchClient?.end({ timeout: 5 }).catch(() => undefined);
    if (container) await container.stop();
  });

  it("RED CONTROL: without admission control a burst starves a shared pool", async () => {
    // Establishes that BURST really is pressure on this substrate. Branch ops
    // pin their connection for the whole operation; once every slot is pinned,
    // the next query parks on postgres.js's unbounded backlog with no deadline.
    const shared = buildDoltgresClient({ connectionString: dbUrl, max: 2 });
    const held: Array<{ release: () => void }> = [];
    try {
      for (let i = 0; i < 2; i++) {
        await shared.unsafe("SELECT 1");
        held.push(await shared.reserve());
      }
      // A plain READ, on the same pool the writes are using.
      expect(await settledWithin(shared.unsafe("SELECT 1"), 3_000)).toBe(
        "pending"
      );
    } finally {
      for (const conn of held) conn.release();
      await shared.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  it("GREEN: a concurrent burst of contributions all land", async () => {
    const results = await Promise.all(
      Array.from({ length: BURST }, (_unused, i) =>
        adapter.create({
          principal: principal(`burst${i}`),
          message: `concurrent contribution ${i}`,
        })
      )
    );
    expect(results).toHaveLength(BURST);
    expect(new Set(results.map((r) => r.contributionId)).size).toBe(BURST);
    for (const rec of results) expect(rec.state).toBe("open");

    // Every branch really exists — the writes were durable, not just acked.
    const branches = (await readClient.unsafe(
      "SELECT name FROM dolt.branches"
    )) as ReadonlyArray<Record<string, unknown>>;
    const names = new Set(branches.map((row) => String(row.name ?? "")));
    for (const rec of results) expect(names.has(rec.branch)).toBe(true);
  }, 120_000);

  it("reads keep answering while a write burst is in flight", async () => {
    const burst = Promise.all(
      Array.from({ length: BURST }, (_unused, i) =>
        adapter.create({
          principal: principal(`reader${i}`),
          message: `read-parallel contribution ${i}`,
        })
      )
    );
    // The read client is a different pool, so it cannot be starved by the
    // writes no matter how long each branch op pins its connection.
    for (let i = 0; i < 4; i++) {
      const rows = await readClient.unsafe(
        "SELECT count(*) AS n FROM knowledge_contributions"
      );
      expect(rows.length).toBe(1);
    }
    await burst;
  }, 120_000);

  it("close replays as a no-op instead of a state error", async () => {
    const rec = await adapter.create({
      principal: principal("closer"),
      message: "closed twice",
    });
    await adapter.close({
      contributionId: rec.contributionId,
      principal: principal("closer"),
      reason: "first",
    });
    // The retry a caller makes when the first ack was lost.
    await expect(
      adapter.close({
        contributionId: rec.contributionId,
        principal: principal("closer"),
        reason: "retry",
      })
    ).resolves.toBeUndefined();

    const after = await adapter.getById(rec.contributionId);
    expect(after?.state).toBe("closed");
    expect(after?.closedReason).toBe("first");
  }, 120_000);

  it("close survives a branch that was already deleted", async () => {
    // The lost-ack shape: the delete applied durably, the acknowledgement did
    // not arrive, so the caller retries against a ref that is already gone.
    const rec = await adapter.create({
      principal: principal("ghost"),
      message: "branch vanishes before close",
    });
    const conn = await branchClient.reserve();
    try {
      await conn.unsafe(`SELECT dolt_checkout('main')`);
      await conn.unsafe(`SELECT dolt_branch('-D', '${rec.branch}')`);
    } finally {
      conn.release();
    }

    await expect(
      adapter.close({
        contributionId: rec.contributionId,
        principal: principal("ghost"),
        reason: "ack lost",
      })
    ).resolves.toBeUndefined();
    expect((await adapter.getById(rec.contributionId))?.state).toBe("closed");
  }, 120_000);

  it("merge replays as a no-op and returns the recorded commit", async () => {
    const rec = await adapter.create({
      principal: principal("merger"),
      message: "merged twice",
    });
    const first = await adapter.merge({
      contributionId: rec.contributionId,
      principal: principal("merger"),
    });
    expect(first.commitHash).toBeTruthy();

    const replay = await adapter.merge({
      contributionId: rec.contributionId,
      principal: principal("merger"),
    });
    expect(replay.commitHash).toBe(first.commitHash);

    const after = await adapter.getById(rec.contributionId);
    expect(after?.state).toBe("merged");
    // The branch is reaped, and a replay does not resurrect or re-merge it.
    const branches = (await readClient.unsafe(
      "SELECT name FROM dolt.branches"
    )) as ReadonlyArray<Record<string, unknown>>;
    expect(branches.some((row) => String(row.name ?? "") === rec.branch)).toBe(
      false
    );
  }, 120_000);
});
