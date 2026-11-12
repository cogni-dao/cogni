// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-credentials-migrator`
 * Purpose: Falsify the shipped migration runner's retained-data/session guards in isolated PostgreSQL.
 * Scope: Real child processes, native inspector and disposable databases; never drizzle-kit or a mocked guard.
 * Invariants: Real history is copied unchanged; fault controls and two-connection allowance exist ONLY in fixtures.
 * Side-effects: IO (CI-only testcontainers, child processes, temporary fixture folders).
 * Links: https://cognidao.org/work/items/story.5156 (migration-safe-v4)
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCredentialConformance } from "@cogni-dao/agent-grants/conformance";
import {
  agentRolesHasRoles,
  assertV1NotSuperseded,
  type CredentialSql,
  confirmCredential,
  createPostgresCredentialStore,
  upgradeSignedKey,
  verifyBearer,
} from "@cogni-dao/agent-grants/credentials";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { parseMigrationReceipt } from "@/shared/migrations/migration-receipt";

const ROOT = resolve(
  fileURLToPath(new URL("../../../../../../", import.meta.url))
);
const RUNNER = join(ROOT, "scripts/db/migrate.mjs");
const FOLDER = join(
  ROOT,
  "nodes/operator/app/src/adapters/server/db/migrations"
);
const WHEN = 1794416513978;
const OLD_HASH =
  "e73dfd033ae61dab25b0d319f25f134f27e1fc802728a9a7c77ac9e1881e4f8d";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Entry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};
type Fixture = {
  admin: Sql;
  service: Sql;
  app: Sql;
  url: string;
  name: string;
};

describe("actual operator migration runner", { timeout: 30_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let control: Sql;
  let baseUrl: string;
  let temp: string;
  let pre63: string;
  let journal: { entries: Entry[]; version: string; dialect: string };
  let nativeLog = "";
  let service: Sql;
  let app: Sql;
  const clients: Sql[] = [];
  const children = new Set<ReturnType<typeof spawn>>();
  const inspectors = new Set<WebSocket>();
  const users: string[] = [];
  let serial = 0;

  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "story5156-runner-"));
    journal = JSON.parse(
      await readFile(join(FOLDER, "meta/_journal.json"), "utf8")
    );
    pre63 = await copyFolder(
      "pre63",
      journal.entries.filter((e) => e.when < WHEN)
    );
    container = await new PostgreSqlContainer("postgres:15-alpine")
      .withCommand([
        "postgres",
        "-c",
        "log_connections=on",
        "-c",
        "log_disconnections=on",
        "-c",
        "log_statement=all",
        "-c",
        "log_line_prefix=%a|%p| ",
      ])
      .start();
    (await container.logs()).on("data", (chunk: Buffer) => {
      nativeLog = (nativeLog + chunk.toString()).slice(-8_000_000);
    });
    baseUrl = container.getConnectionUri();
    control = postgres(baseUrl, { max: 1 });
    // Private fixture identities, never copied from an environment. Two admitted
    // migration sessions are necessary to test advisory serialization itself.
    await control.unsafe(
      "CREATE ROLE app_operator LOGIN PASSWORD 'fixture' NOSUPERUSER NOBYPASSRLS"
    );
    await control.unsafe(
      "CREATE ROLE migration_operator LOGIN PASSWORD 'fixture' NOSUPERUSER NOBYPASSRLS IN ROLE app_operator CONNECTION LIMIT 2"
    );
    await control.unsafe(
      "CREATE ROLE service_operator LOGIN PASSWORD 'fixture' NOSUPERUSER BYPASSRLS"
    );
    const fresh = await fixture();
    const result = await run(fresh);
    expect(result.code, result.output).toBe(0);
    await fresh.admin.unsafe(
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_operator, app_operator"
    );
    await fresh.admin.unsafe(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_operator, app_operator"
    );
    service = fresh.service;
    app = fresh.app;
    const receipt = parseMigrationReceipt(result.output);
    expect(receipt?.applied.filter((e) => e.appliedAtMs === WHEN)).toEqual([
      expect.objectContaining({
        hash: sha(
          await readFile(join(FOLDER, "0063_wet_midnight.sql"), "utf8")
        ),
      }),
    ]);
  }, 90_000);

  afterEach(() => {
    for (const ws of inspectors) ws.close();
    inspectors.clear();
    for (const child of children) child.kill("SIGKILL");
  });

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(clients.map((c) => c.end({ timeout: 1 })));
    await control?.end({ timeout: 1 });
    await container?.stop();
    if (temp) await rm(temp, { recursive: true, force: true });
  }, 30_000);

  async function copyFolder(name: string, entries = journal.entries) {
    const folder = join(temp, name);
    await cp(FOLDER, folder, { recursive: true });
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries })
    );
    return folder;
  }

  async function fixture(): Promise<Fixture> {
    const name = `runner_${++serial}`;
    await control.unsafe(`CREATE DATABASE "${name}" OWNER app_operator`);
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    const connect = (role: string, password: string) => {
      const u = new URL(url);
      u.username = role;
      u.password = password;
      const c = postgres(u.toString(), { max: 1 });
      clients.push(c);
      return c;
    };
    const admin = postgres(url.toString(), { max: 1 });
    clients.push(admin);
    const fixtureService = connect("service_operator", "fixture");
    const fixtureApp = connect("app_operator", "fixture");
    url.username = "migration_operator";
    url.password = "fixture";
    return {
      admin,
      service: fixtureService,
      app: fixtureApp,
      url: url.toString(),
      name,
    };
  }

  function start(
    f: Fixture,
    options: {
      folder?: string;
      node?: string;
      inspect?: boolean;
      shadow?: boolean;
    } = {}
  ) {
    const label = `story5156_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(f.url);
    url.searchParams.set("application_name", label);
    if (options.shadow)
      url.searchParams.set(
        "options",
        "-c search_path=shadow,pg_catalog,public"
      );
    const args = [
      ...(options.inspect ? ["--inspect-brk=127.0.0.1:0"] : []),
      RUNNER,
      options.folder ?? FOLDER,
    ];
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        NODE_NAME: options.node ?? "operator",
        DATABASE_URL: url.toString(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let output = "";
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const done = new Promise<{ code: number | null; output: string }>(
      (resolveDone, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
          children.delete(child);
          resolveDone({ code, output });
        });
      }
    );
    return { child, label, done, output: () => output };
  }

  async function run(f: Fixture, folder = FOLDER, node = "operator") {
    return start(f, { folder, node }).done;
  }

  async function readyBefore63(f: Fixture) {
    expect((await run(f, pre63, "fixture-pre63")).code).toBe(0);
  }

  async function until<T>(
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    timeout = 8_000
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await read();
      if (accept(result)) return result;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("fixture observation deadline expired");
  }

  async function retained(f: Fixture) {
    const ledger =
      await f.admin`SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, hash`;
    const rows: Record<string, unknown> = {};
    for (const name of [
      "agent_credentials",
      "agent_principals",
      "agent_roles",
      "related",
    ]) {
      const [found] =
        await f.admin`SELECT pg_catalog.to_regclass(${`public.${name}`}) AS relation`;
      if (found?.relation)
        rows[name] = await f.admin.unsafe(
          `SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`
        );
    }
    const definitions = await f.admin`
      SELECT c.conname, pg_catalog.pg_get_constraintdef(c.oid) AS definition
      FROM pg_catalog.pg_constraint c WHERE c.connamespace = 'public'::regnamespace ORDER BY c.conname`;
    return JSON.stringify({ ledger, rows, definitions });
  }

  async function refused(f: Fixture, code: string) {
    const before = await retained(f);
    const result = await run(f);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(code);
    expect(result.output).not.toContain("✅");
    expect(result.output).not.toContain("fixture-retained");
    // Boolean comparison avoids leaking private fixture rows in a diff.
    expect((await retained(f)) === before).toBe(true);
  }

  it("refuses a populated draft plus inbound FK without touching data/history", async () => {
    const f = await fixture();
    await readyBefore63(f);
    await f.admin.unsafe(
      "CREATE TABLE agent_credentials(id integer PRIMARY KEY, secret_hash text); INSERT INTO agent_credentials VALUES (1,'fixture-retained'); CREATE TABLE related(id integer REFERENCES agent_credentials); INSERT INTO related VALUES(1)"
    );
    await refused(f, "migration_authority_collision");
  });

  it("refuses canonical populated collisions before lifecycle mutation", async () => {
    const f = await fixture();
    expect((await run(f)).code).toBe(0);
    await f.admin`INSERT INTO users(id,name) VALUES ('retained-user','fixture')`;
    await f.admin`INSERT INTO agent_principals(user_id,kind) VALUES ('retained-user','external')`;
    await f.admin`INSERT INTO agent_roles(principal_user_id,scope) VALUES ('retained-user','fixture:read')`;
    await f.admin`INSERT INTO agent_credentials(user_id,token_hash,created_from,expires_at,renew_until,confirmed_at) VALUES ('retained-user',${"a".repeat(64)},'key_upgrade',now()+interval '1 day',now()+interval '2 days',now())`;
    await f.admin`DELETE FROM drizzle.__drizzle_migrations WHERE created_at=${WHEN}`;
    await refused(f, "migration_authority_collision");
  });

  it.each([
    "agent_principals",
    "agent_roles",
    "agent_credentials",
  ])("refuses even an empty %s relation", async (table) => {
    const f = await fixture();
    await readyBefore63(f);
    await f.admin.unsafe(`CREATE TABLE "${table}"(id integer)`);
    await refused(f, "migration_authority_collision");
  });

  it.each([
    "agent_credential_state",
    "agent_principals_refuse_wallet_binding",
    "agent_credentials_require_external_principal",
  ])("preserves a replaceable %s function", async (name) => {
    const f = await fixture();
    await readyBefore63(f);
    await f.admin.unsafe(
      `CREATE FUNCTION public.${name}() RETURNS text LANGUAGE sql AS $$ SELECT 'retained'::text $$`
    );
    const before =
      await f.admin`SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.proname=${name}`;
    await refused(f, "migration_authority_collision");
    expect(
      await f.admin`SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.proname=${name}`
    ).toEqual(before);
  });

  it("preserves the exact wallet trigger collision", async () => {
    const f = await fixture();
    await readyBefore63(f);
    await f.admin.unsafe(
      "CREATE FUNCTION fixture_wallet() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER agent_principals_no_wallet_binding BEFORE INSERT ON user_bindings FOR EACH ROW EXECUTE FUNCTION fixture_wallet()"
    );
    const before =
      await f.admin`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname='agent_principals_no_wallet_binding'`;
    await refused(f, "migration_authority_collision");
    expect(
      await f.admin`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname='agent_principals_no_wallet_binding'`
    ).toEqual(before);
  });

  it.each([
    OLD_HASH,
    "current",
  ])("skips and preserves the accepted %s history exactly", async (hash) => {
    const f = await fixture();
    expect((await run(f)).code).toBe(0);
    if (hash === OLD_HASH)
      await f.admin`UPDATE drizzle.__drizzle_migrations SET hash=${hash} WHERE created_at=${WHEN}`;
    await f.admin`INSERT INTO users(id,name) VALUES ('history-user','fixture'),('history-admin','fixture')`;
    await f.admin`INSERT INTO agent_principals(user_id,kind) VALUES ('history-user','external')`;
    await f.admin`INSERT INTO user_bindings(id,user_id,provider,external_id) VALUES (${randomUUID()},'history-user','github',${randomUUID()})`;
    await f.admin`INSERT INTO agent_roles(principal_user_id,scope,approved_by,granted_at) VALUES ('history-user','fixture:read','history-admin',now())`;
    const before = await retained(f);
    const result = await run(f);
    expect(result.code, result.output).toBe(0);
    expect((await retained(f)) === before).toBe(true);
    await f.admin.unsafe(
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_operator"
    );
    const live = createPostgresCredentialStore(
      f.service as unknown as CredentialSql,
      { hasRoles: agentRolesHasRoles(f.service as unknown as CredentialSql) }
    );
    const key = await upgradeSignedKey(live, { userId: "history-user" });
    if (!key.ok) throw new Error("historical fixture upgrade failed");
    expect(
      (await confirmCredential(live, { credentialId: key.credentialId })).ok
    ).toBe(true);
    expect(await verifyBearer(live, key.apiKey)).toMatchObject({ ok: true });
    expect(
      await f.admin`SELECT principal_user_id,scope FROM agent_roles`
    ).toEqual([{ principal_user_id: "history-user", scope: "fixture:read" }]);
    expect(
      parseMigrationReceipt(result.output)?.applied.find(
        (e) => e.appliedAtMs === WHEN
      )?.hash
    ).toBe(
      hash === OLD_HASH
        ? OLD_HASH
        : sha(await readFile(join(FOLDER, "0063_wet_midnight.sql"), "utf8"))
    );
  });

  it("refuses a genuinely known later sentinel when the exact0063 row is absent", async () => {
    const f = await fixture();
    await readyBefore63(f);
    const sentinel = {
      idx: 64,
      version: "7",
      when: WHEN + 1,
      tag: "0064_fixture_sentinel",
      breakpoints: true,
    };
    const folder = await copyFolder("sentinel", [...journal.entries, sentinel]);
    const sql = "SELECT 1;\n";
    await writeFile(join(folder, `${sentinel.tag}.sql`), sql);
    await f.admin`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (${sha(sql)},${sentinel.when})`;
    const before = await retained(f);
    const result = await run(f, folder);
    expect(result.output).toContain("migration_authority_row_missing");
    expect(result.code).not.toBe(0);
    expect((await retained(f)) === before).toBe(true);
  });

  it.each([
    "unknown_hash",
    "unknown_time",
    "duplicate",
    "null_time",
  ])("refuses decisive malformed/unknown ledger: %s", async (kind) => {
    const f = await fixture();
    expect((await run(f)).code).toBe(0);
    if (kind === "unknown_hash")
      await f.admin`UPDATE drizzle.__drizzle_migrations SET hash=${"0".repeat(64)} WHERE created_at=${WHEN}`;
    if (kind === "unknown_time")
      await f.admin`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (${"0".repeat(64)},${WHEN + 1})`;
    if (kind === "duplicate")
      await f.admin`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT hash,created_at FROM drizzle.__drizzle_migrations WHERE created_at=${WHEN}`;
    if (kind === "null_time")
      await f.admin`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (${"0".repeat(64)},NULL)`;
    await refused(f, "migration_history_");
  });

  it("does not turn a ledger permission error into a fresh database", async () => {
    const f = await fixture();
    await readyBefore63(f);
    await f.admin`ALTER TABLE drizzle.__drizzle_migrations OWNER TO ${f.admin(container.getUsername())}`;
    await f.admin.unsafe(
      "REVOKE ALL ON drizzle.__drizzle_migrations FROM PUBLIC,app_operator,migration_operator"
    );
    await refused(f, "42501");
  });

  // The production file is not patched and has no fault flag. Inspector controls
  // only the real child process in CI, at its awaited preflight/migrate seam.
  async function paused(
    f: Fixture,
    shadow = true,
    boundary = "await migrate(drizzle(sql)"
  ) {
    const running = start(f, { inspect: true, shadow });
    const output = await until(
      async () => running.output(),
      (s) => /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.test(s)
    );
    const url = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/)?.[0];
    if (!url) throw new Error("inspector URL missing");
    const ws = new WebSocket(url);
    inspectors.add(ws);
    await once(ws, "open");
    let id = 0;
    type Reply = {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
      method?: string;
      params?: { hitBreakpoints?: string[] };
    };
    const pending = new Map<
      number,
      {
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: Error) => void;
      }
    >();
    const events: Reply[] = [];
    ws.on("message", (raw) => {
      const msg: Reply = JSON.parse(raw.toString());
      if (msg.id !== undefined) {
        const request = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) request?.reject(new Error(msg.error.message));
        else request?.resolve(msg.result ?? {});
      } else events.push(msg);
    });
    ws.on("close", () => {
      for (const p of pending.values()) p.reject(new Error("inspector closed"));
      pending.clear();
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolveReply, reject) => {
        const n = ++id;
        pending.set(n, { resolve: resolveReply, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    await send("Debugger.enable");
    const source = await readFile(RUNNER, "utf8");
    const lineNumber = source
      .split("\n")
      .findIndex((line) => line.includes(boundary));
    const breakpoint = await send("Debugger.setBreakpointByUrl", {
      url: pathToFileURL(RUNNER).href,
      lineNumber,
    });
    await send("Runtime.runIfWaitingForDebugger");
    await until(async () => {
      const event = events.find((e) => e.method === "Debugger.paused");
      if (!event) return false;
      events.splice(events.indexOf(event), 1);
      if (
        event.params?.hitBreakpoints?.includes(String(breakpoint.breakpointId))
      )
        return true;
      await send("Debugger.resume");
      return false;
    }, Boolean);
    return {
      ...running,
      resume: async () => {
        await send("Debugger.resume");
        ws.close();
      },
      detach: () => ws.close(),
    };
  }

  async function shadow(f: Fixture) {
    await f.admin.unsafe(
      "CREATE SCHEMA shadow AUTHORIZATION app_operator; CREATE TABLE shadow.agent_credentials(id integer PRIMARY KEY, marker text); INSERT INTO shadow.agent_credentials VALUES(1,'must-survive'); CREATE TABLE shadow.calls(name text); GRANT ALL ON ALL TABLES IN SCHEMA shadow TO migration_operator"
    );
    await f.admin.unsafe(
      "CREATE FUNCTION shadow.pg_advisory_lock(bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO shadow.calls VALUES('lock'); END $$; CREATE FUNCTION shadow.pg_advisory_unlock(bigint) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN INSERT INTO shadow.calls VALUES('unlock'); RETURN true; END $$"
    );
  }

  it("fails closed on IDLE loss before migrate, never reconnects destructive work, then safely retries", async () => {
    const f = await fixture();
    await readyBefore63(f);
    await shadow(f);
    const before = await retained(f);
    const child = await paused(f);
    try {
      const rows =
        await control`SELECT pid,state FROM pg_stat_activity WHERE application_name=${child.label}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("idle");
      await control`SELECT pg_terminate_backend(${rows[0]?.pid})`;
      await until(
        async () =>
          control`SELECT pid FROM pg_stat_activity WHERE application_name=${child.label}`,
        (r) => r.length === 0
      );
      await child.resume();
      const result = await child.done;
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("migration_session_lost");
      expect(result.output).not.toContain("✅");
      expect((await retained(f)) === before).toBe(true);
      expect(
        await f.admin`SELECT marker FROM shadow.agent_credentials`
      ).toEqual([{ marker: "must-survive" }]);
      // Durable native statement/connection stream, not a point-in-time PID check.
      const lines = nativeLog
        .split("\n")
        .filter((line) => line.includes(child.label));
      expect(new Set(lines.map((line) => line.split("|")[1])).size).toBe(1);
      expect(
        lines.some((line) =>
          /DROP TABLE|CREATE SCHEMA IF NOT EXISTS/.test(line)
        )
      ).toBe(false);
      const retry = await start(f, { shadow: true }).done;
      expect(retry.code, retry.output).toBe(0);
      expect(
        await f.admin`SELECT count(*)::int AS n FROM shadow.calls`
      ).toEqual([{ n: 0 }]);
      expect(
        await f.admin`SELECT marker FROM shadow.agent_credentials`
      ).toEqual([{ marker: "must-survive" }]);
    } finally {
      child.detach();
    }
  }, 45_000);

  it("admits TWO runners and proves native advisory waiting despite shadow functions", async () => {
    const f = await fixture();
    await readyBefore63(f);
    await shadow(f);
    const first = await paused(f);
    const second = start(f, { shadow: true });
    try {
      const admitted = await until(
        async () =>
          control`SELECT pid,wait_event FROM pg_stat_activity WHERE application_name IN (${first.label},${second.label})`,
        (r) => r.length === 2 && r.some((x) => x.wait_event === "advisory")
      );
      expect(admitted).toHaveLength(2);
      await first.resume();
      expect((await first.done).code).toBe(0);
      const result = await second.done;
      expect(result.code, result.output).toBe(0);
      expect(
        await f.admin`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at=${WHEN}`
      ).toEqual([{ n: 1 }]);
      expect(
        await f.admin`SELECT count(*)::int AS n FROM shadow.calls`
      ).toEqual([{ n: 0 }]);
      // C1: counters prove no shadow invocation, NOT unlock spelling.
      // Explicit pg_catalog unlock qualification remains an implementation review gate.
    } finally {
      first.detach();
    }
  }, 45_000);

  it("rolls back a failing pending batch and succeeds on a safe fresh-process retry", async () => {
    const f = await fixture();
    await readyBefore63(f);
    const sentinel = {
      idx: 64,
      version: "7",
      when: WHEN + 1,
      tag: "0064_fixture_failure",
      breakpoints: true,
    };
    const folder = await copyFolder("failure", [...journal.entries, sentinel]);
    await writeFile(
      join(folder, `${sentinel.tag}.sql`),
      "CREATE TABLE fixture_partial(id integer); SELECT 1/0;"
    );
    const before = await retained(f);
    expect((await run(f, folder)).code).not.toBe(0);
    expect((await retained(f)) === before).toBe(true);
    expect(
      await f.admin`SELECT to_regclass('public.agent_credentials') AS relation, to_regclass('public.fixture_partial') AS partial`
    ).toEqual([{ relation: null, partial: null }]);
    expect((await run(f)).code).toBe(0);
  });

  it("interruption rolls back a real pending transaction and fresh retry reobserves", async () => {
    const f = await fixture();
    await readyBefore63(f);
    const entry = {
      idx: 64,
      version: "7",
      when: WHEN + 1,
      tag: "0064_fixture_sleep",
      breakpoints: true,
    };
    const folder = await copyFolder("interrupted", [...journal.entries, entry]);
    await writeFile(
      join(folder, `${entry.tag}.sql`),
      "CREATE TABLE fixture_partial(id integer); SELECT pg_sleep(30);"
    );
    const before = await retained(f);
    const child = start(f, { folder });
    const active = await until(
      async () =>
        control`SELECT pid FROM pg_stat_activity WHERE application_name=${child.label} AND wait_event='PgSleep'`,
      (r) => r.length === 1
    );
    child.child.kill("SIGKILL");
    await control`SELECT pg_terminate_backend(${active[0]?.pid})`;
    await child.done;
    await until(
      async () =>
        control`SELECT pid FROM pg_stat_activity WHERE application_name=${child.label}`,
      (r) => r.length === 0
    );
    expect((await retained(f)) === before).toBe(true);
    expect((await run(f)).code).toBe(0);
  }, 45_000);

  it("fresh failing chain leaves tracking bootstrap but no application batch or ledger entries", async () => {
    const f = await fixture();
    const entry = {
      idx: 64,
      version: "7",
      when: WHEN + 1,
      tag: "0064_fixture_bootstrap_failure",
      breakpoints: true,
    };
    const folder = await copyFolder("bootstrap_failure", [
      ...journal.entries,
      entry,
    ]);
    await writeFile(join(folder, `${entry.tag}.sql`), "SELECT 1/0;");
    const result = await run(f, folder);
    expect(result.code).not.toBe(0);
    expect(
      await f.admin`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
    ).toEqual([{ n: 0 }]);
    expect(
      await f.admin`SELECT to_regclass('public.users') AS relation`
    ).toEqual([{ relation: null }]);
  });

  it("postcommit ledger failure suppresses success without pretending DDL rolled back", async () => {
    const f = await fixture();
    await readyBefore63(f);
    const child = await paused(
      f,
      false,
      "if (artifact) await authorityPostcheck"
    );
    try {
      await f.admin`UPDATE drizzle.__drizzle_migrations SET hash=${"0".repeat(64)} WHERE created_at=${WHEN}`;
      await child.resume();
      const result = await child.done;
      expect(result.code).not.toBe(0);
      expect(result.output).not.toContain("✅");
      expect(
        await f.admin`SELECT to_regclass('public.agent_credentials') IS NOT NULL AS present`
      ).toEqual([{ present: true }]);
      expect(
        await f.admin`SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=${WHEN}`
      ).toEqual([{ hash: "0".repeat(64) }]);
    } finally {
      child.detach();
    }
  }, 45_000);

  it("receipt failure stays best effort and cannot supply required release evidence", async () => {
    const f = await fixture();
    await readyBefore63(f);
    const child = await paused(f, false, "await reportReceipt(sql");
    try {
      await f.admin`ALTER TABLE drizzle.__drizzle_migrations OWNER TO ${f.admin(container.getUsername())}`;
      await f.admin.unsafe(
        "REVOKE ALL ON drizzle.__drizzle_migrations FROM PUBLIC,app_operator,migration_operator"
      );
      await child.resume();
      const result = await child.done;
      expect(result.code).toBe(0);
      expect(parseMigrationReceipt(result.output)).toBeNull();
      expect(result.output).toContain("migration receipt not emitted");
    } finally {
      child.detach();
    }
  }, 45_000);

  it("known history still needs real schema/conformance qualification", async () => {
    const f = await fixture();
    expect((await run(f)).code).toBe(0);
    await f.admin.unsafe(
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_operator"
    );
    await f.admin.unsafe(
      "DROP FUNCTION agent_credential_state(agent_credentials); ALTER TABLE agent_credentials NO FORCE ROW LEVEL SECURITY"
    );
    expect((await run(f)).code).toBe(0);
    const broken = createPostgresCredentialStore(
      f.service as unknown as CredentialSql,
      { hasRoles: async () => false }
    );
    await f.admin`INSERT INTO users(id,name) VALUES ('negative-control','fixture')`;
    expect(
      await upgradeSignedKey(broken, { userId: "negative-control" })
    ).toMatchObject({ ok: false });
    expect(
      await f.admin`SELECT relforcerowsecurity FROM pg_class WHERE oid='public.agent_credentials'::regclass`
    ).toEqual([{ relforcerowsecurity: false }]);
  });

  const makeUser = async () => {
    const id = randomUUID();
    users.push(id);
    await service`INSERT INTO users(id,name) VALUES (${id},'runner-conformance')`;
    return id;
  };
  const store = () =>
    createPostgresCredentialStore(service as unknown as CredentialSql, {
      hasRoles: agentRolesHasRoles(service as unknown as CredentialSql),
    });

  runCredentialConformance({
    describe,
    it,
    expect,
    async setup(facts) {
      const ids: Record<string, string> = {};
      for (const [name, f] of Object.entries(facts)) {
        const id = await makeUser();
        ids[name] = id;
        const admin = f.roles ? await makeUser() : null;
        if (f.wallet)
          await service`UPDATE users SET wallet_address = ${`0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`} WHERE id = ${id}`;
        if (f.internal)
          await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('internal', ${`conf-${id}`}, ${id})`;
        if (f.roles)
          await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${id}, 'probe:scope', ${admin}, now())`;
        if (f.github)
          await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, 'github', ${`gh-${randomUUID()}`})`;
      }
      return { store: store(), ids };
    },
    async age(credentialId, to) {
      if (to === "pending_expired")
        await service`UPDATE agent_credentials SET pending_expires_at = now() - interval '1 second' WHERE id = ${credentialId}`;
      else if (to === "renew_only")
        await service`UPDATE agent_credentials SET expires_at = now() - interval '1 hour', renew_until = now() + interval '1 day' WHERE id = ${credentialId}`;
      else
        await service`UPDATE agent_credentials SET expires_at = now() - interval '2 hour', renew_until = now() - interval '1 minute' WHERE id = ${credentialId}`;
    },
    async addRoles(userId) {
      const admin = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${userId}, 'probe:scope', ${admin}, now())`;
    },
    broken: () =>
      createPostgresCredentialStore(
        (async () => {
          throw new Error("db down");
        }) as unknown as CredentialSql,
        { hasRoles: async () => false }
      ),
    storedHash: async (credentialId) =>
      (
        await service`SELECT token_hash FROM agent_credentials WHERE id = ${credentialId}`
      )[0]?.token_hash ?? null,
    liveSuccessors: async (predecessorId) =>
      (
        await service`SELECT count(*)::int AS n FROM agent_credentials WHERE predecessor_id = ${predecessorId} AND confirmed_at IS NULL AND revoked_at IS NULL`
      )[0]?.n ?? 0,
  });

  it("qualifies canonical RLS/triggers/indexes and rejects wrong-role credential reads", async () => {
    const rows =
      await service`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('public.agent_credentials'::regclass,'public.agent_principals'::regclass,'public.agent_roles'::regclass)`;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(
      true
    );
    expect(await app`SELECT 1 FROM agent_credentials`).toHaveLength(0);
    const id = await makeUser();
    const key = await upgradeSignedKey(store(), { userId: id });
    if (!key.ok) throw new Error("fixture upgrade refused");
    expect(
      (await confirmCredential(store(), { credentialId: key.credentialId })).ok
    ).toBe(true);
    const wrong = createPostgresCredentialStore(
      app as unknown as CredentialSql,
      { hasRoles: async () => false }
    );
    await expect(assertV1NotSuperseded(wrong, id)).rejects.toMatchObject({
      code: "authz_unavailable",
    });
    expect(await verifyBearer(wrong, key.apiKey)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await expect(
      service`INSERT INTO user_bindings(id,user_id,provider,external_id) VALUES (${randomUUID()},${id},'wallet','fixture-wallet')`
    ).rejects.toThrow();
    const ordinary = await makeUser();
    await expect(
      service`INSERT INTO agent_credentials(user_id,token_hash,created_from,expires_at,renew_until) VALUES (${ordinary},'fixture','rotation',now(),now()+interval '1 day')`
    ).rejects.toThrow();
    expect(
      await service`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('agent_credentials','agent_principals','agent_roles')`
    ).toHaveLength(10);
    const triggers =
      await service`SELECT tgname FROM pg_trigger WHERE tgname IN ('agent_principals_no_wallet_binding','agent_credentials_external_principal_only')`;
    expect(triggers).toHaveLength(2);
  });
});
