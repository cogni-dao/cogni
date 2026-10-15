// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Native administrative contract on ONE explicitly isolated localhost Poly fixture. */
import { readFile } from "node:fs/promises";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS } from "../../../src/shared/secrets/database-cell-binding.data";

const nodeId = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(40);
let sql: postgres.Sql;
let actuator: postgres.Sql;
let probe: postgres.Sql;
let container: StartedPostgreSqlContainer | undefined;
let packet: Record<string, unknown>;
let pgid: string;
const fixturePassword = "native_control_fixture_only";
let fixtureUrl: string;
const migration = (name: string) =>
  readFile(
    new URL(
      `../../../../../../infra/compose/runtime/postgres-init/control-migrations/${name}`,
      import.meta.url
    ),
    "utf8"
  );
async function importPacket(value: Record<string, unknown>) {
  return sql`SELECT public.import_database_cell_admission(${sql.json(value as postgres.JSONValue)}) AS receipt`;
}

beforeAll(async () => {
  let url = process.env.COGNI_NATIVE_CONTROL_FIXTURE_URL;
  if (!url) {
    container = await new PostgreSqlContainer("postgres:15-alpine")
      .withUsername("postgres")
      .withDatabase("postgres")
      .withCommand([
        "postgres",
        "-c",
        "cluster_name=task5246-poly-fixture",
        "-c",
        "shared_buffers=16MB",
        "-c",
        "max_connections=24",
        "-c",
        "work_mem=8MB",
      ])
      .start();
    url = container.getConnectionUri();
  }
  fixtureUrl = url;
  const endpoint = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(endpoint.hostname))
    throw new Error("fixture endpoint must be loopback");
  sql = postgres(url, { max: 1, prepare: false });
  const [{ label, database, role }] = await sql<
    { label: string; database: string; role: string }[]
  >`SELECT current_setting('cluster_name') label, current_database() AS database, session_user AS role`;
  if (
    label !== "task5246-poly-fixture" ||
    database !== "postgres" ||
    role !== "postgres"
  )
    throw new Error(
      "owned fixture requires its administrative postgres database and session identity"
    );
  endpoint.password = fixturePassword;
  endpoint.username = "database_reliability_actuator";
  actuator = postgres(endpoint.toString(), { max: 1, prepare: false });
  endpoint.username = "probe_poly_fixture";
  probe = postgres(endpoint.toString(), { max: 1, prepare: false });
  const [{ id }] = await sql<
    { id: string }[]
  >`SELECT system_identifier::text id FROM pg_control_system()`;
  if (!id) throw new Error("isolated fixture native ID missing");
  pgid = id;
  // Refuse the two known production native identities even if a local forwarding error exists.
  if (["7696772948626829358", "7671049237154275366"].includes(pgid))
    throw new Error("fixture cannot target production");
  await sql.unsafe(`CREATE ROLE database_reliability_actuator LOGIN PASSWORD '${fixturePassword}'; CREATE ROLE database_reliability_readmitter LOGIN PASSWORD '${fixturePassword}';
    CREATE ROLE app_poly_fixture LOGIN CONNECTION LIMIT 4;
    CREATE ROLE service_poly_fixture LOGIN CONNECTION LIMIT 8;
    CREATE ROLE probe_poly_fixture LOGIN PASSWORD '${fixturePassword}' CONNECTION LIMIT 2;
    ALTER ROLE probe_poly_fixture SET default_transaction_read_only=on;
    `);
  await sql.unsafe("CREATE DATABASE cogni_poly_fixture OWNER app_poly_fixture");
  for (const [role, stmt, temp] of [
    ["app_poly_fixture", 5000, 256],
    ["service_poly_fixture", 2000, 128],
  ] as const) {
    await sql.unsafe(`ALTER ROLE ${role} SET statement_timeout='${stmt}ms'; ALTER ROLE ${role} SET lock_timeout='0';
      ALTER ROLE ${role} SET idle_in_transaction_session_timeout='30s'; ALTER ROLE ${role} SET temp_file_limit='${temp}MB'; ALTER ROLE ${role} SET work_mem='8MB';`);
  }
  await sql.unsafe(`CREATE FUNCTION public.contain_database_role(text) RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture disabled legacy function';END$$;
    CREATE FUNCTION public.readmit_database_role(text) RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture disabled legacy function';END$$;`);
  for (const name of [
    "0000_database_recovery_control.sql",
    "0001_database_recovery_watchdog.sql",
    "0002_dedicated_cell_admission.sql",
  ])
    await sql.unsafe(await migration(name));
  await sql.unsafe(
    "DROP FUNCTION public.contain_database_role(text); DROP FUNCTION public.readmit_database_role(text)"
  );
  const now = new Date(Date.now() - 1000).toISOString();
  packet = {
    node_id: nodeId,
    node_slug: "poly-fixture",
    environment: "production",
    allocation_receipt_id: "22222222-2222-4222-8222-222222222222",
    dseq: "123456789",
    provider_account: `akash1${"a".repeat(38)}`,
    database_system_identifier: pgid,
    database_name: "cogni_poly_fixture",
    app_role: "app_poly_fixture",
    service_role: "service_poly_fixture",
    probe_role: "probe_poly_fixture",
    target_build_sha: sha,
    manual_packet_sha256: "b".repeat(64),
    readmission_receipt_sha256: "c".repeat(64),
    execution_actor: { kind: "agent", id: nodeId },
    approval_authority: {
      kind: "conversation-user",
      label: "CEO",
      humanAppUserId: null,
      source: "direct-user-instruction",
      decisionRef: "fixture-direct-approval",
      capturedAt: now,
      delegationDigest: "d".repeat(64),
    },
    preserved_role_bounds: [
      {
        name: "app_poly_fixture",
        connectionLimit: 4,
        statementTimeoutMs: 5000,
        lockTimeoutMs: 0,
        idleInTransactionTimeoutMs: 30000,
        tempFileLimitMiB: 256,
        workMemMiB: 8,
      },
      {
        name: "service_poly_fixture",
        connectionLimit: 8,
        statementTimeoutMs: 2000,
        lockTimeoutMs: 0,
        idleInTransactionTimeoutMs: 30000,
        tempFileLimitMiB: 128,
        workMemMiB: 8,
      },
    ],
    admitted_at: now,
    reviewed_control_source_sha: sha,
    migration_manifest_sha256: "e".repeat(64),
    installed_at: now,
  };
}, 30000);
afterAll(async () => {
  await Promise.all([
    sql?.end({ timeout: 1 }),
    actuator?.end({ timeout: 1 }),
    probe?.end({ timeout: 1 }),
  ]);
  await container?.stop();
});

describe.sequential("owned Poly native control", () => {
  it("imports actual admission without role changes or fabricated incident", async () => {
    await importPacket(packet);
    await importPacket(packet);
    const [{ incidents }] = await sql<
      { incidents: number }[]
    >`SELECT count(*)::int incidents FROM cogni_control.database_recoveries`;
    expect(incidents).toBe(0);
    const rows =
      await sql`SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('app_poly_fixture','service_poly_fixture')`;
    expect(rows.every((row) => row.rolcanlogin)).toBe(true);
  });
  it("rejects null, malformed, rebound or wrong-native imports", async () => {
    for (const delta of [
      { execution_actor: {} },
      { approval_authority: {} },
      { database_system_identifier: "123" },
      { database_name: "cogni_other" },
      { preserved_role_bounds: [] },
      { manual_packet_sha256: "f".repeat(64) },
    ])
      await expect(importPacket({ ...packet, ...delta })).rejects.toThrow();
    await expect(importPacket({})).rejects.toThrow();
  });
  it("qualifies exactly15 owner/hash/privilege/search-path facts and refuses foreign node", async () => {
    await actuator.unsafe(
      "SELECT public.database_recovery_watchdog_tick('production','fixture-independent-watchdog')"
    );
    await sql.unsafe(
      "GRANT EXECUTE ON FUNCTION public.begin_database_recovery(uuid,text,text,text,text,text,text) TO database_reliability_readmitter; GRANT EXECUTE ON FUNCTION public.database_cell_control_qualification(uuid,text) TO probe_poly_fixture"
    );
    await expect(
      probe.unsafe(
        "SELECT public.database_cell_control_qualification($1::uuid,'production')",
        ["33333333-3333-4333-8333-333333333333"]
      )
    ).rejects.toThrow();
    const [row] = await probe.unsafe<
      {
        observation: {
          requiredFunctions: {
            signature: string;
            definitionSha256: string;
            owner: string;
            publicCanExecute: boolean;
            searchPath: string;
            securityDefiner: boolean;
            probeCanExecute: boolean;
            actuatorCanExecute: boolean;
            readmitterCanExecute: boolean;
          }[];
        };
      }[]
    >(
      "SELECT public.database_cell_control_qualification($1::uuid,'production') AS observation",
      [nodeId]
    );
    expect(row?.observation.requiredFunctions).toHaveLength(15);
    for (const fn of row?.observation.requiredFunctions ?? []) {
      const expected = DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.find(
        (value) => value.signature === fn.signature
      );
      expect(expected).toBeDefined();
      expect(fn).toMatchObject(expected ?? {});
      expect(fn.owner).toBe("postgres");
      expect(fn.publicCanExecute).toBe(false);
      expect(fn.definitionSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fn.searchPath.replaceAll(/\s/g, "")).toBe("pg_catalog,pg_temp");
    }
    await expect(
      actuator.unsafe("SELECT public.import_database_cell_admission('{}')")
    ).rejects.toThrow();
  });
  it("distinguishes idle from active owned replay pressure and contains all owned roles", async () => {
    await sql.unsafe(
      `CREATE ROLE replay_poly_fixture NOLOGIN PASSWORD '${fixturePassword}' CONNECTION LIMIT 8; ALTER ROLE replay_poly_fixture SET default_transaction_read_only=on`
    );
    await sql.unsafe(
      "SELECT public.register_database_cell_replay($1::uuid,'production','cogni_poly_fixture','replay_poly_fixture',8,$2)",
      [nodeId, "f".repeat(64)]
    );
    await sql.unsafe("ALTER ROLE replay_poly_fixture LOGIN");
    const replayUrl = new URL(fixtureUrl);
    replayUrl.username = "replay_poly_fixture";
    replayUrl.password = fixturePassword;
    replayUrl.pathname = "/cogni_poly_fixture";
    const replay = postgres(replayUrl.toString(), { max: 1, prepare: false });
    try {
      await replay`SELECT 1`;
      const [idle] = await actuator.unsafe<
        { o: { roles: { name: string; active: number; idle: number }[] } }[]
      >("SELECT public.database_cell_pressure($1::uuid,'production') o", [
        nodeId,
      ]);
      expect(
        idle?.o.roles.find((r) => r.name === "replay_poly_fixture")
      ).toMatchObject({ active: 0, idle: 1 });
      const active = replay`SELECT pg_sleep(5)`.catch(() => undefined);
      // Fixed aggregate polling only, bounded to one second to wait for actual active backend visibility.
      let observed = false;
      for (let i = 0; i < 10; i++) {
        const [row] = await actuator.unsafe<
          { o: { roles: { name: string; active: number }[] } }[]
        >("SELECT public.database_cell_pressure($1::uuid,'production') o", [
          nodeId,
        ]);
        if (
          row?.o.roles.find((r) => r.name === "replay_poly_fixture")?.active ===
          1
        ) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(observed).toBe(true);
      await expect(
        actuator.unsafe(
          "SELECT public.contain_database_incident($1::uuid,'other','production','wrong','system:fixture','critical_connections',$2,$3,'cogni_other')",
          [nodeId, sha, pgid]
        )
      ).rejects.toThrow();
      await actuator.unsafe(
        "SELECT public.contain_database_incident($1::uuid,'poly-fixture','production','genuine-fixture-incident','system:fixture','critical_connections',$2,$3,'cogni_poly_fixture')",
        [nodeId, sha, pgid]
      );
      await active;
      const roles =
        await sql`SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('app_poly_fixture','service_poly_fixture','replay_poly_fixture')`;
      expect(roles).toHaveLength(3);
      expect(roles.every((r) => !r.rolcanlogin)).toBe(true);
      const [{ sessions }] = await sql<
        { sessions: number }[]
      >`SELECT count(*)::int sessions FROM pg_stat_activity WHERE usename IN ('app_poly_fixture','service_poly_fixture','replay_poly_fixture')`;
      expect(sessions).toBe(0);
    } finally {
      await replay.end({ timeout: 1 });
    }
  });
  it("records actual existing-incident manual readmission with exact CAS and append-only audit", async () => {
    const [before] = await sql<
      { contained_at: string; state: string }[]
    >`SELECT contained_at::text,state FROM cogni_control.database_recoveries WHERE incident_id='genuine-fixture-incident'`;
    if (!before) throw new Error("actual incident absent");
    // Test stand-in for separately audited manual admission; import itself must never do this mutation.
    await sql.unsafe(
      "ALTER ROLE app_poly_fixture LOGIN; ALTER ROLE service_poly_fixture LOGIN"
    );
    const next = {
      ...packet,
      manual_packet_sha256: "1".repeat(64),
      readmission_receipt_sha256: "2".repeat(64),
      admitted_at: new Date().toISOString(),
      external_incident_id: "genuine-fixture-incident",
      expected_incident_state: before.state,
      expected_contained_at: before.contained_at,
      expected_previous_receipt_sha256: "c".repeat(64),
    };
    for (const delta of [
      { expected_incident_state: "recovering" },
      { expected_contained_at: new Date(0).toISOString() },
      { expected_previous_receipt_sha256: "9".repeat(64) },
      { external_incident_id: "invented-incident" },
    ])
      await expect(importPacket({ ...next, ...delta })).rejects.toThrow();
    await importPacket(next);
    await importPacket(next);
    await expect(
      importPacket({ ...next, readmission_receipt_sha256: "3".repeat(64) })
    ).rejects.toThrow();
    const [after] = await sql<
      { contained_at: string; state: string; actor_id: string }[]
    >`SELECT contained_at::text,state,actor_id FROM cogni_control.database_recoveries WHERE incident_id='genuine-fixture-incident'`;
    expect(after?.contained_at).toBe(before.contained_at);
    expect(after?.state).toBe("readmitted");
    expect(after?.actor_id).toBe(`agent:${nodeId}`);
    const [{ n }] = await sql<
      { n: number }[]
    >`SELECT count(*)::int n FROM cogni_control.database_cell_readmission_audits`;
    expect(n).toBe(1);
    const [baseline] =
      await sql`SELECT readmission_receipt_sha256 FROM cogni_control.database_cell_admissions`;
    expect(baseline?.readmission_receipt_sha256).toBe("c".repeat(64));
  });
});
