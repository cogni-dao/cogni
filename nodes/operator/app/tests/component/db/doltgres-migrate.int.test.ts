// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/doltgres-migrate`
 * Purpose: Prove actual operator migration history, read-only startup and drift verification.
 * Scope: Owned native component tests. Does not connect to deployed databases.
 * Invariants: Fresh historical migrations succeed; applied startup preserves HEAD/journal; drift fails closed.
 * Side-effects: IO, process.env
 * Notes: Uses real immutable operator migrations, including duplicate 0002/0004 drops.
 * Links: scripts/db/migrate-doltgres.mjs, scripts/db/verify-doltgres-schema.mjs
 * @internal
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres, { type Sql } from "postgres";
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
const OTHER_DB = "knowledge_attribution_other";
// PR Build39724315855 / manifest artifact12403190038; compile once, test the published bytes.
const DG_IMAGE =
  "ghcr.io/cogni-dao/cogni-template@sha256:f892b365ad6fc6c683da839260f20c4015615c105176a3c21c015ca90d2b70a3";
const EXPECTED_BINARY_SHA256 =
  "8ecc5f8a764fe5a70ca3cac76452dc17377bc446136891478c7ee19a5a9eb2b9";
const require = createRequire(import.meta.url);
const { auditDoltProducerDrain } = (await import(
  new URL(`file://${MIGRATE_SCRIPT}`).href
)) as {
  auditDoltProducerDrain: (sql: Sql, expectedDatabase: string) => Promise<void>;
};

type Activity = {
  pid: number;
  datname: string | null;
  usename: string | null;
  state: string;
  query: string | null;
};
const nativeClient = (url: string) =>
  postgres(url, {
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 0,
    max_lifetime: 0,
    connect_timeout: 5,
  });
const activity = (sql: Sql) =>
  sql.unsafe<Activity[]>(
    "SELECT pid, datname, usename, state, query FROM pg_catalog.pg_stat_activity"
  );
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("native_observation_deadline");
}
const scalarHash = (value: unknown): string => {
  const hash = Array.isArray(value) ? value[0] : value;
  if (typeof hash !== "string" || !/^[a-z0-9]{32,64}$/i.test(hash))
    throw new Error("native_head_unproven");
  return hash;
};
async function unknownStartup(host: string, port: number): Promise<net.Socket> {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(5000, () =>
    socket.destroy(new Error("native_socket_deadline"))
  );
  try {
    await once(socket, "connect");
    const challenge = new Promise<void>((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      const timer = setTimeout(
        () => finish(new Error("native_auth_challenge_deadline")),
        5000
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.off("data", data);
        socket.off("error", fail);
        error ? reject(error) : resolve();
      };
      const fail = (error: Error) => finish(error);
      const data = (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 9) return;
        if (
          bytes[0] !== 82 ||
          bytes.readInt32BE(1) < 8 ||
          bytes.readInt32BE(5) === 0
        ) {
          finish(new Error("native_auth_challenge_unproven"));
          return;
        }
        finish();
      };
      socket.on("data", data);
      socket.on("error", fail);
    });
    const parameters = Buffer.from(`user\0${DG_USER}\0database\0${DG_DB}\0\0`);
    const startup = Buffer.alloc(8 + parameters.length);
    startup.writeInt32BE(startup.length, 0);
    startup.writeInt32BE(196608, 4);
    parameters.copy(startup, 8);
    socket.write(startup);
    await challenge;
    socket.setTimeout(0);
    socket.on("error", () => undefined);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

describe("doltgres migrator + schema verification", () => {
  let container: StartedTestContainer;
  let baseUrl: string;
  let dbUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer(DG_IMAGE)
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
      await bootstrap.unsafe(`CREATE DATABASE ${OTHER_DB}`);
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    } finally {
      await bootstrap.end({ timeout: 5 });
    }
  }, 180_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  it("published engine identity is recorded without substituting a locally compiled binary", async () => {
    const binary = await container.exec([
      "sha256sum",
      "/usr/local/bin/doltgres",
    ]);
    const version = await container.exec([
      "/usr/local/bin/doltgres",
      "--version",
    ]);
    expect(binary.exitCode).toBe(0);
    expect(version.exitCode).toBe(0);
    expect(binary.stdout).toMatch(
      /^[0-9a-f]{64}\s+\/usr\/local\/bin\/doltgres/
    );
    expect(binary.stdout.split(/\s+/)[0]).toBe(EXPECTED_BINARY_SHA256);
    expect(version.stdout.trim()).toBe("Doltgres version 0.57.3");
    const imageId = execFileSync(
      "docker",
      [
        "inspect",
        "--type",
        "container",
        "--format",
        "{{.Image}}",
        container.getId(),
      ],
      { encoding: "utf8", stdio: "pipe" }
    ).trim();
    expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    console.info("doltgres_qualification_identity", {
      requestedImage: DG_IMAGE,
      imageId,
      binarySha256: binary.stdout.split(/\s+/)[0],
      binaryVersion: version.stdout.trim(),
      declaredUpstreamCommit: "f4bc507d9764f9b7b2e1a5dca740b03d7e30f0ca",
      declaredPatchSha256:
        "6091c572e9fa8bd293b2064978f00d6feb6a920f2d1da4fb1480626327743629",
    });
  });

  it("attributes real idle/active sessions and same-PID database switches", async () => {
    const observer = nativeClient(
      baseUrl.replace(/\/postgres$/, `/${OTHER_DB}`)
    );
    const subject = nativeClient(dbUrl);
    const auditor = nativeClient(dbUrl);
    let running: Promise<unknown> | undefined;
    try {
      const [own] = await subject.unsafe(
        "SELECT pg_backend_pid() AS pid, current_database() AS database"
      );
      const pid = Number(own.pid);
      expect(own.database).toBe(DG_DB);
      expect(
        (await activity(observer)).find((row) => Number(row.pid) === pid)
      ).toMatchObject({ datname: DG_DB, usename: DG_USER, state: "idle" });
      await expect(auditDoltProducerDrain(auditor, DG_DB)).rejects.toThrow(
        "operator_drain_native_producers_present"
      );
      running = subject.unsafe("SELECT pg_sleep(1)").then(() => undefined);
      await eventually(
        () => activity(observer),
        (rows) =>
          rows.some(
            (row) =>
              Number(row.pid) === pid &&
              row.state === "active" &&
              row.datname === DG_DB
          )
      );
      await running;
      for (const database of [OTHER_DB, DG_DB, OTHER_DB]) {
        await subject.unsafe(`SET database TO '${database}'`);
        const [now] = await subject.unsafe(
          "SELECT pg_backend_pid() AS pid, current_database() AS database"
        );
        expect(Number(now.pid)).toBe(pid);
        expect(now.database).toBe(database);
        expect(
          (await activity(observer)).find((row) => Number(row.pid) === pid)
            ?.datname
        ).toBe(database);
      }
      await subject.end({ timeout: 2 });
      await eventually(
        () => activity(observer),
        (rows) => rows.every((row) => Number(row.pid) !== pid)
      );
    } finally {
      await running;
      await subject.end({ timeout: 2 });
      await auditor.end({ timeout: 2 });
      await observer.end({ timeout: 2 });
    }
  });

  it("keeps deleted-branch and detached revision producers visible to the unchanged native auditor", async () => {
    const auditor = nativeClient(dbUrl);
    const observer = nativeClient(
      baseUrl.replace(/\/postgres$/, `/${OTHER_DB}`)
    );
    const subject = nativeClient(dbUrl);
    const detachedSubject = nativeClient(dbUrl);
    let branchCreated = false;
    try {
      await auditor.unsafe("SELECT dolt_branch('attribution_deleted_fixture')");
      branchCreated = true;
      await subject.unsafe(
        `SET database TO '${DG_DB}/attribution_deleted_fixture'`
      );
      const [identity] = await subject.unsafe("SELECT pg_backend_pid() AS pid");
      const pid = Number(identity.pid);
      await auditor.unsafe(
        "SELECT dolt_branch('-D', 'attribution_deleted_fixture')"
      );
      branchCreated = false;
      expect(
        (await activity(observer)).find((row) => Number(row.pid) === pid)
          ?.datname
      ).toBe(`${DG_DB}/attribution_deleted_fixture`);
      await expect(auditDoltProducerDrain(auditor, DG_DB)).rejects.toThrow(
        "operator_drain_native_producers_present"
      );
      const [head] = await auditor.unsafe("SELECT dolt_hashof('HEAD') AS hash");
      const revision = scalarHash(head.hash);
      // Do not require a deleted branch's query context to recover in order to
      // prove attribution. A separate live session changes to the detached ref.
      await subject.end({ timeout: 2 });
      const [beforeDetached] = await detachedSubject.unsafe(
        "SELECT pg_backend_pid() AS pid"
      );
      await detachedSubject.unsafe(`SET database TO '${DG_DB}/${revision}'`);
      const [detached] = await detachedSubject.unsafe(
        "SELECT pg_backend_pid() AS pid"
      );
      expect(Number(detached.pid)).toBe(Number(beforeDetached.pid));
      expect(
        (await activity(observer)).find(
          (row) => Number(row.pid) === Number(detached.pid)
        )?.datname
      ).toBe(`${DG_DB}/${revision}`);
      await expect(auditDoltProducerDrain(auditor, DG_DB)).rejects.toThrow(
        "operator_drain_native_producers_present"
      );
    } finally {
      await subject.end({ timeout: 2 });
      await detachedSubject.end({ timeout: 2 });
      if (branchCreated)
        await auditor.unsafe(
          "SELECT dolt_branch('-D', 'attribution_deleted_fixture')"
        );
      await observer.end({ timeout: 2 });
      await auditor.end({ timeout: 2 });
    }
  });

  it("permits known unrelated database sessions but refuses real unauthenticated and dirty states before DML", async () => {
    const auditor = nativeClient(dbUrl);
    const other = nativeClient(baseUrl.replace(/\/postgres$/, `/${OTHER_DB}`));
    let socket: net.Socket | undefined;
    const creator = nativeClient(dbUrl);
    let dirty = false;
    try {
      await other.unsafe("SELECT 1");
      const snapshot = async () => ({
        head: await auditor.unsafe("SELECT dolt_hashof('HEAD') AS hash"),
        status: await auditor.unsafe("SELECT * FROM dolt.status"),
      });
      const clean = await snapshot();
      expect(clean.status).toHaveLength(0);
      await auditDoltProducerDrain(auditor, DG_DB);
      expect(await snapshot()).toEqual(clean);
      await expect(auditDoltProducerDrain(auditor, OTHER_DB)).rejects.toThrow(
        "operator_drain_native_identity_unproven"
      );
      expect(await snapshot()).toEqual(clean);
      const beforePids = new Set(
        (await activity(other)).map((row) => Number(row.pid))
      );
      socket = await unknownStartup(
        container.getHost(),
        container.getMappedPort(5432)
      );
      const rows = await eventually(
        () => activity(other),
        (items) =>
          items.some((row) => !beforePids.has(Number(row.pid)) && !row.datname)
      );
      const unknown = rows.filter(
        (row) => !beforePids.has(Number(row.pid)) && !row.datname
      );
      expect(unknown).toHaveLength(1);
      await expect(auditDoltProducerDrain(auditor, DG_DB)).rejects.toThrow(
        "operator_drain_native_producers_present"
      );
      expect(await snapshot()).toEqual(clean);
      socket.destroy();
      socket = undefined;
      await eventually(
        () => activity(other),
        (items) =>
          items.every((row) => Number(row.pid) !== Number(unknown[0]?.pid))
      );
      await creator.unsafe(
        "CREATE TABLE attribution_dirty_fixture (id integer)"
      );
      dirty = true;
      const [creatorIdentity] = await creator.unsafe(
        "SELECT pg_backend_pid() AS pid"
      );
      await creator.end({ timeout: 2 });
      await eventually(
        () => activity(other),
        (rows) =>
          rows.every((row) => Number(row.pid) !== Number(creatorIdentity.pid))
      );
      const beforeRefusal = await snapshot();
      expect(beforeRefusal.status.length).toBeGreaterThan(0);
      await expect(auditDoltProducerDrain(auditor, DG_DB)).rejects.toThrow(
        "operator_drain_main_dirty"
      );
      expect(await snapshot()).toEqual(beforeRefusal);
      await auditor.unsafe("DROP TABLE attribution_dirty_fixture");
      dirty = false;
      expect(await snapshot()).toEqual(clean);
    } finally {
      socket?.destroy();
      if (dirty) await auditor.unsafe("DROP TABLE attribution_dirty_fixture");
      await creator.end({ timeout: 2 });
      await other.end({ timeout: 2 });
      await auditor.end({ timeout: 2 });
    }
  });

  it("does not hide a 45-second native query when its owning client process is lost", async () => {
    const observer = nativeClient(
      baseUrl.replace(/\/postgres$/, `/${OTHER_DB}`)
    );
    const auditor = nativeClient(dbUrl);
    const code = `const postgres=require(${JSON.stringify(require.resolve("postgres"))});const sql=postgres(process.env.ATTRIBUTION_FIXTURE_DSN,{max:1,prepare:false,fetch_types:false});(async()=>{const [r]=await sql.unsafe('SELECT pg_backend_pid() AS pid');console.log(JSON.stringify({pid:Number(r.pid)}));await sql.unsafe('SELECT pg_sleep(45)');await sql.end();})().catch(()=>process.exitCode=1);`;
    const child = spawn(process.execPath, ["-e", code], {
      env: { ...process.env, ATTRIBUTION_FIXTURE_DSN: dbUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    child.stderr.resume();
    let pid: number | undefined;
    try {
      pid = await new Promise<number>((resolve, reject) => {
        let bytes = "";
        const timer = setTimeout(
          () => reject(new Error("native_child_identity_deadline")),
          5000
        );
        child.stdout.on("data", (chunk) => {
          bytes += chunk.toString();
          if (!bytes.includes("\n")) return;
          clearTimeout(timer);
          try {
            const row = JSON.parse(bytes.split("\n")[0] ?? "");
            if (!Number.isSafeInteger(row.pid) || row.pid < 1)
              throw new Error("native_child_pid_unproven");
            resolve(row.pid);
          } catch (error) {
            reject(error);
          }
        });
        child.once("error", reject);
      });
      await eventually(
        () => activity(observer),
        (rows) =>
          rows.some(
            (row) =>
              Number(row.pid) === pid &&
              row.datname === DG_DB &&
              row.state === "active" &&
              row.query?.includes("pg_sleep(45)") === true
          )
      );
      expect(child.kill("SIGKILL")).toBe(true);
      await exited;
      // The client process is absent; the native process must remain observable
      // and block admission while its already-running SQL is still outstanding.
      expect(
        (await activity(observer)).find((row) => Number(row.pid) === pid)
      ).toMatchObject({ datname: DG_DB, state: "active" });
      await expect(auditDoltProducerDrain(auditor, DG_DB)).rejects.toThrow(
        "operator_drain_native_producers_present"
      );
      await eventually(
        () => activity(observer),
        (rows) => rows.every((row) => Number(row.pid) !== pid),
        55000
      );
      await auditDoltProducerDrain(auditor, DG_DB);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      if (pid !== undefined)
        await eventually(
          () => activity(observer),
          (rows) => rows.every((row) => Number(row.pid) !== pid),
          55000
        );
      await observer.end({ timeout: 2 });
      await auditor.end({ timeout: 2 });
    }
  }, 120_000);

  it("cold first point lookups materialize out-of-band knowledge/work TEXT before iterator cleanup", async () => {
    const coldDatabase = "knowledge_cold_text";
    const coldUrl = baseUrl.replace(/\/postgres$/, `/${coldDatabase}`);
    const admin = nativeClient(baseUrl);
    const content = "knowledge-cold-payload-é|".repeat(1024);
    const outcome = "work-outcome-cold-payload-λ|".repeat(4096);
    try {
      await admin.unsafe(`CREATE DATABASE ${coldDatabase}`);
    } finally {
      await admin.end({ timeout: 2 });
    }
    const seed = nativeClient(coldUrl);
    try {
      await seed.unsafe(
        "CREATE TABLE cold_knowledge (id text PRIMARY KEY, content text)"
      );
      await seed.unsafe(
        "CREATE TABLE cold_work_items (id text PRIMARY KEY, outcome text)"
      );
      // Pinned 0.57.3 does not support the driver's parameter-description
      // Flush message. Seed controlled strings with its existing simple protocol.
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
      await seed.unsafe(
        `INSERT INTO cold_knowledge VALUES ('database-expert', ${literal(content)}), ('second-guide', ${literal("other-knowledge|".repeat(1024))})`
      );
      await seed.unsafe(
        `INSERT INTO cold_work_items VALUES ('story.5095', ${literal(outcome)}), ('task.5278', ${literal("other-outcome|".repeat(4096))})`
      );
      await seed.unsafe("SELECT dolt_add('cold_knowledge')");
      await seed.unsafe("SELECT dolt_add('cold_work_items')");
      await seed.unsafe(
        "SELECT dolt_commit('-m', 'owned cold TEXT qualification')"
      );
    } finally {
      await seed.end({ timeout: 2 });
    }
    // Gracefully stop ONLY this owned disposable engine's native child. A
    // Docker/PID1 TERM can hit the upstream wrapper's broken wait/trap path.
    await container.exec([
      "sh",
      "-c",
      `
      set -eu
      found=
      for file in /proc/[0-9]*/comm; do
        read -r name < "$file" || continue
        if [ "$name" = doltgres ]; then
          test -z "$found"
          found=\${file#/proc/}
          found=\${found%/comm}
        fi
      done
      test -n "$found"
      kill -TERM "$found"
    `,
    ]);
    await eventually(
      async () =>
        JSON.parse(
          execFileSync(
            "docker",
            ["inspect", "--format", "{{json .State}}", container.getId()],
            { encoding: "utf8" }
          )
        ),
      (state) => !state.Running,
      30_000
    );
    const stopped = JSON.parse(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{json .State}}", container.getId()],
        { encoding: "utf8" }
      )
    );
    expect(stopped).toMatchObject({
      Running: false,
      ExitCode: 0,
      OOMKilled: false,
    });
    execFileSync("docker", ["start", container.getId()], { stdio: "pipe" });
    await eventually(
      async () =>
        (
          await container.exec([
            "sh",
            "-c",
            'PGCONNECT_TIMEOUT=3 PGPASSWORD="$DOLTGRES_PASSWORD" psql -X -w -h127.0.0.1 -Upostgres -d postgres -Atc "SELECT 1"',
          ])
        ).exitCode,
      (code) => code === 0,
      30_000
    );
    // New native process has no warmed NodeStore chunks. Read neither payload
    // in a multi-row query before these FIRST exact max-one-row point lookups.
    const reader = nativeClient(coldUrl);
    try {
      const knowledge = await reader.unsafe(
        "SELECT content FROM cold_knowledge WHERE id = 'database-expert' LIMIT 1"
      );
      expect(knowledge).toEqual([{ content }]);
      const work = await reader.unsafe(
        "SELECT outcome FROM cold_work_items WHERE id = 'story.5095' LIMIT 1"
      );
      expect(work).toEqual([{ outcome }]);
      expect(
        await reader.unsafe(
          "SELECT content FROM cold_knowledge WHERE id = 'database-expert' LIMIT 1"
        )
      ).toEqual([{ content }]);
      expect(
        await reader.unsafe(
          "SELECT outcome FROM cold_work_items WHERE id = 'story.5095' LIMIT 1"
        )
      ).toEqual([{ outcome }]);
      expect(
        await reader.unsafe(
          "SELECT content FROM cold_knowledge WHERE id IN ('database-expert','second-guide')"
        )
      ).toHaveLength(2);
      expect(
        await reader.unsafe(
          "SELECT outcome FROM cold_work_items WHERE id IN ('story.5095','task.5278')"
        )
      ).toHaveLength(2);
      expect(
        await reader.unsafe(
          "SELECT content FROM cold_knowledge WHERE id = 'missing' LIMIT 1"
        )
      ).toHaveLength(0);
      console.info("doltgres_cold_text_point_lookup", {
        image: DG_IMAGE,
        knowledgeBytes: Buffer.byteLength(content),
        outcomeBytes: Buffer.byteLength(outcome),
        coldPointLookups: 2,
        sameClientRepeats: 2,
        nativeCleanRestart: true,
      });
    } finally {
      await reader.end({ timeout: 2 });
    }
  }, 120_000);

  it("fresh DB: migrator applies all migrations + verifier passes", async () => {
    // Run the ACTUAL migrator script — same code path as the k8s initContainer.
    const result = execSync(`node ${MIGRATE_SCRIPT} ${MIGRATIONS_DIR}`, {
      env: { ...process.env, DATABASE_URL: dbUrl, NODE_NAME: "operator" },
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(result).toMatch(/migration\(s\) applied \+ verified/);
    expect(result).toMatch(/owned branch committed/);

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

  it("already-applied startup is read-only after the historical duplicate drops", async () => {
    const sql = postgres(dbUrl, { max: 1 });
    const snapshot = async () => ({
      head: await sql.unsafe("SELECT dolt_hashof('HEAD') AS hash"),
      journal: await sql.unsafe(
        "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at"
      ),
      status: await sql.unsafe("SELECT * FROM dolt.status"),
    });
    try {
      const before = await snapshot();
      expect(before.status).toHaveLength(0);
      const result = execSync(`node ${MIGRATE_SCRIPT} ${MIGRATIONS_DIR}`, {
        env: { ...process.env, DATABASE_URL: dbUrl, NODE_NAME: "operator" },
        encoding: "utf8",
        stdio: "pipe",
      });
      expect(result).toContain("read-only no-op; no journal DDL or commit");
      expect(await snapshot()).toEqual(before);
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
