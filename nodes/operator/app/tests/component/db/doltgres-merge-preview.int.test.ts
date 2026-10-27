// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/doltgres-merge-preview`
 * Purpose: Prove native conflict checks, fresh metadata and retained session ownership on the qualified engine.
 * Scope: Ephemeral minimal Dolt schema plus real adapter/executor. Does not access production or mock a database.
 * Invariants: Hidden fields can conflict; clean checks change no refs; timeout never replaces native capacity.
 * Side-effects: IO (Docker container, test database schema, native SQL), time (timers)
 * Links: https://cognidao.org/work/items/spike.5016
 * @internal
 */
import {
  buildDoltgresClient,
  DoltBranchSessionRunner,
  DoltgresKnowledgeContributionAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import postgres, { type Sql } from "postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Same immutable custom engine as runtime Compose and doltgres-migrate tests.
const IMAGE =
  "ghcr.io/cogni-dao/cogni-template@sha256:f892b365ad6fc6c683da839260f20c4015615c105176a3c21c015ca90d2b70a3";
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const hash = (v: unknown) => {
  const h = Array.isArray(v) ? v[0] : v;
  if (typeof h !== "string" || !/^[0-9a-v]{32}$/.test(h))
    throw new Error("unproven native hash");
  return h;
};
async function commit(sql: Sql, message: string) {
  await sql.unsafe("SELECT dolt_add('-A')");
  await sql.unsafe(
    `SELECT dolt_commit('-m', ${literal(message)}, '--author', 'Preview test <preview@test.invalid>')`
  );
  return hash((await sql.unsafe("SELECT dolt_hashof('HEAD') AS h"))[0]?.h);
}

describe("qualified native contribution preview", () => {
  let container: StartedTestContainer;
  let setup: Sql;
  let reader: Sql;
  let branch: Sql;
  let writer: DoltBranchSessionRunner;
  let adapter: DoltgresKnowledgeContributionAdapter;
  const conflictId = "contrib-preview-conflict";
  const cleanId = "contrib-preview-clean";
  let cleanHead: string;

  async function addContribution(id: string, edit: string) {
    const base = hash(
      (await setup.unsafe("SELECT dolt_hashof('main') AS h"))[0]?.h
    );
    const ref = `contrib/${id}`;
    await setup.unsafe(
      `INSERT INTO knowledge_contributions (id,branch,base_commit,head_commit,commit_count,state,principal_kind,principal_id,message,created_at) VALUES (${literal(id)},${literal(ref)},${literal(base)},NULL,0,'open','agent','preview-test','preview',now())`
    );
    await commit(setup, `register ${id}`);
    await setup.unsafe(`SELECT dolt_checkout('-b', ${literal(ref)}, 'main')`);
    await setup.unsafe(edit);
    const head = await commit(setup, `edit ${id}`);
    await setup.unsafe("SELECT dolt_checkout('main')");
    await setup.unsafe(
      `UPDATE knowledge_contributions SET head_commit=${literal(head)},commit_count=1 WHERE id=${literal(id)}`
    );
    await commit(setup, `record ${id}`);
    return head;
  }

  async function refsAndState() {
    return {
      refs: await setup.unsafe(
        "SELECT name, hash FROM dolt.branches ORDER BY name"
      ),
      status: await setup.unsafe("SELECT * FROM dolt.status"),
      merging: await setup.unsafe("SELECT is_merging FROM dolt.merge_status"),
    };
  }

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ DOLTGRES_PASSWORD: "preview-test" })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
          90_000
        )
      )
      .start();
    const origin = `postgresql://postgres:preview-test@${container.getHost()}:${container.getMappedPort(5432)}`;
    const admin = postgres(`${origin}/postgres`, {
      max: 1,
      prepare: false,
      fetch_types: false,
    });
    await admin.unsafe("CREATE DATABASE knowledge_preview");
    await admin.end();
    const url = `${origin}/knowledge_preview`;
    setup = buildDoltgresClient({ connectionString: url, max: 1 });
    await setup.unsafe(
      "CREATE TABLE knowledge (id TEXT PRIMARY KEY,title TEXT,content TEXT,confidence_pct INTEGER)"
    );
    await setup.unsafe(
      "CREATE TABLE knowledge_contributions (id TEXT PRIMARY KEY,branch TEXT,base_commit TEXT,head_commit TEXT,commit_count INTEGER,state TEXT,principal_kind TEXT,principal_id TEXT,message TEXT,merged_commit TEXT,closed_reason TEXT,idempotency_key TEXT,created_at TIMESTAMP,resolved_at TIMESTAMP,resolved_by TEXT)"
    );
    await setup.unsafe(
      "INSERT INTO knowledge VALUES ('same-cell','Visible title','Visible body',60)"
    );
    await commit(setup, "initial fixture");
    await addContribution(
      conflictId,
      "UPDATE knowledge SET confidence_pct=70 WHERE id='same-cell'"
    );
    await setup.unsafe(
      "UPDATE knowledge SET confidence_pct=80 WHERE id='same-cell'"
    );
    await commit(setup, "main changes hidden confidence field");
    cleanHead = await addContribution(
      cleanId,
      "INSERT INTO knowledge VALUES ('incoming-only','Independent','Incoming body',60)"
    );
    await setup.unsafe(
      "INSERT INTO knowledge VALUES ('main-only','Independent','Main body',60)"
    );
    await commit(setup, "independent main change");
    reader = buildDoltgresClient({ connectionString: url, max: 1 });
    branch = buildDoltgresClient({ connectionString: url, max: 1 });
    writer = new DoltBranchSessionRunner(branch, {
      writerProtocol: "database",
      queryTimeoutMs: 1000,
      queueWaitMs: 2000,
    });
    adapter = new DoltgresKnowledgeContributionAdapter({
      sql: reader,
      writerSession: writer,
    });
  }, 180_000);

  afterAll(async () => {
    await reader?.end({ timeout: 5 });
    await branch?.end({ timeout: 5 });
    await setup?.end({ timeout: 5 });
    await container?.stop();
  });

  it("detects a real hidden-field conflict without mutating refs or working state", async () => {
    const before = await refsAndState();
    const result = await adapter.previewMerge(conflictId);
    expect(result.status).toBe("conflicted");
    // Doltgres keeps the PostgreSQL schema in TableName.String(); the native
    // summary returns public.knowledge rather than an unqualified table name.
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "public.knowledge",
          dataConflicts: "1",
        }),
      ])
    );
    expect(await refsAndState()).toEqual(before);
  });

  it("passes an independent real change using immutable commit arguments", async () => {
    const before = await refsAndState();
    expect(await adapter.previewMerge(cleanId)).toMatchObject({
      status: "clean",
      contributionCommit: cleanHead,
      conflicts: [],
    });
    expect(await refsAndState()).toEqual(before);
  });

  it("retains a late native query, serves ordinary reads, then admits a queued mutation", async () => {
    // This real server function does not honor PostgreSQL cancellation. Its
    // running query outlives the caller's1s budget on the SAME native owner.
    let heldKeys: readonly string[] = [];
    const slow = writer.run(
      "test.preview_late_native",
      async (conn, guard, owner) => {
        heldKeys = guard.keys;
        owner.registerReconciliation(
          async () => !(await conn.unsafe("SELECT * FROM dolt.status")).length
        );
        await conn.unsafe("SELECT pg_sleep(2)");
      },
      { awaitSettlement: true }
    );
    await expect(slow).rejects.toThrow();
    const activity = await setup.unsafe(
      "SELECT pid,query,state FROM pg_catalog.pg_stat_activity"
    );
    expect(
      activity.filter(
        (r) => String(r.query).includes("pg_sleep(2)") && r.state === "active"
      )
    ).toHaveLength(1);
    expect(heldKeys.length).toBeGreaterThan(0);
    for (const key of heldKeys) {
      expect(key).toMatch(/^-?[0-9]+$/);
      expect(
        (
          await setup.unsafe(`SELECT pg_try_advisory_lock(${key}) AS acquired`)
        )[0]?.acquired
      ).toBe(false);
    }
    expect((await adapter.previewMerge(cleanId)).status).toBe("unavailable");
    const readStartedAt = performance.now();
    expect(
      (await reader.unsafe("SELECT COUNT(*) AS n FROM knowledge"))[0]
    ).toBeDefined();
    expect(performance.now() - readStartedAt).toBeLessThan(400);
    expect(
      (
        await setup.unsafe(
          "SELECT query,state FROM pg_catalog.pg_stat_activity"
        )
      ).filter(
        (r) => String(r.query).includes("pg_sleep(2)") && r.state === "active"
      )
    ).toHaveLength(1);
    expect(writer.client).toBe(branch);
    // Polling the product operation is bounded; unavailable retains capacity.
    const deadline = Date.now() + 5000;
    let status = "unavailable";
    while (Date.now() < deadline && status === "unavailable") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (await adapter.previewMerge(cleanId)).status;
    }
    expect(status).toBe("clean");
    for (const key of heldKeys) {
      expect(
        (
          await setup.unsafe(`SELECT pg_try_advisory_lock(${key}) AS acquired`)
        )[0]?.acquired
      ).toBe(true);
      await setup.unsafe(`SELECT pg_advisory_unlock(${key})`);
    }
    // Hold a known, non-timed-out native read on that same owner; start an
    // actual contribution mutation while it owns the session and native lock.
    const barrier = writer.run(
      "test.queued_after_preview",
      async (conn, _guard, owner) => {
        owner.registerReconciliation(
          async () => !(await conn.unsafe("SELECT * FROM dolt.status")).length
        );
        await conn.unsafe("SELECT pg_sleep(0.5)");
      },
      { awaitSettlement: true }
    );
    const startedDeadline = Date.now() + 3000;
    while (
      !(
        await setup.unsafe(
          "SELECT query,state FROM pg_catalog.pg_stat_activity"
        )
      ).some(
        (r) => String(r.query).includes("pg_sleep(0.5)") && r.state === "active"
      )
    ) {
      if (Date.now() > startedDeadline)
        throw new Error("queued-read fixture did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let mutationSettled = false;
    const mutation = adapter
      .close({
        contributionId: conflictId,
        principal: { id: "preview-test", kind: "agent" },
        reason: "native fixture cleanup",
      })
      .finally(() => {
        mutationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mutationSettled).toBe(false);
    await barrier;
    await mutation;
    await setup.unsafe("SELECT dolt_checkout('main')");
    expect(
      (
        await setup.unsafe(
          `SELECT state FROM knowledge_contributions WHERE id=${literal(conflictId)}`
        )
      )[0]?.state
    ).toBe("closed");
  });

  it("refreshes a warmed native session after another connection closes the inbox", async () => {
    expect((await adapter.previewMerge(cleanId)).status).toBe("clean");
    await setup.unsafe(
      `UPDATE knowledge_contributions SET state='closed' WHERE id=${literal(cleanId)}`
    );
    await commit(setup, "another connection closes contribution");
    expect(await adapter.previewMerge(cleanId)).toMatchObject({
      status: "changed",
      reason: "not_open",
    });
  });
});
