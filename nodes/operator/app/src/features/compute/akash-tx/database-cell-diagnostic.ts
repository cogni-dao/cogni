// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Purpose: Prepare an isolated read-only diagnostic clone on one existing cell.
 * Scope: Private actuator root kit and its durable ready allocation binding.
 * Invariants: No allocation, parent role admission, caller SQL or credential output.
 * Side-effects: Fixed scoped CREATE DATABASE/ROLE and read-only data fingerprints.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import postgres from "postgres";
import { z } from "zod";
import { AkashTxError } from "@/ports";
import type {
  DatabaseCellBinding,
  DatabaseCellBootstrapKit,
} from "@/shared/secrets/database-cell-binding.data";

export interface DatabaseCellDiagnosticReceipt {
  readonly version: 1;
  readonly action: "diagnostic-clone";
  readonly allocationReceiptId: string;
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: "production";
  readonly provider: "akash";
  readonly providerAccount: string;
  readonly dseq: string;
  readonly failureDomainId: string;
  readonly systemIdentifier: string;
  readonly sourceSha: string;
  readonly targetBuildSha: string;
  readonly sourceDatabaseName: string;
  readonly databaseName: string;
  readonly replayRole: string;
  readonly connectionLimit: 8;
  readonly statementTimeoutMs: 2000;
  readonly verification: { readonly rows: string; readonly sha256: string };
  readonly completedAt: string;
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
function privateClient(
  kit: DatabaseCellBootstrapKit,
  binding: DatabaseCellBinding,
  database: string,
  statementTimeoutMs = 600000
) {
  const url = new URL("postgres://cell.invalid");
  url.hostname = binding.endpoint.host;
  url.port = String(binding.endpoint.port);
  url.username = "postgres";
  url.password = kit.rootPassword;
  url.pathname = `/${database}`;
  return postgres(url.toString(), {
    ssl: { ca: kit.tlsCaCertificate, rejectUnauthorized: true },
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    connection: {
      application_name: "database-cell-diagnostic",
      statement_timeout: statementTimeoutMs,
      search_path: "pg_catalog,pg_temp",
    },
  });
}
async function fingerprint(client: ReturnType<typeof postgres>) {
  const commands = await client.unsafe<{ command: string }[]>(`
    SELECT format('SELECT jsonb_build_object(''schema'',%L,''table'',%L,''rows'',count(*)::text,''high'',coalesce(sum((''x''||substr(md5(to_jsonb(data)::text),1,16))::bit(64)::bigint::numeric),0)::text,''low'',coalesce(sum((''x''||substr(md5(to_jsonb(data)::text),17,16))::bit(64)::bigint::numeric),0)::text) AS proof FROM %I.%I AS data', n.nspname,c.relname,n.nspname,c.relname) AS command
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','m') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog','information_schema','cogni_control')
      AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname`);
  const hash = createHash("sha256");
  let rows = 0n;
  for (const { command } of commands) {
    const [result] =
      await client.unsafe<{ proof: { rows: string } }[]>(command);
    if (!result) throw new Error("diagnostic fingerprint absent");
    rows += BigInt(result.proof.rows);
    hash.update(JSON.stringify(result.proof));
  }
  return { rows: rows.toString(), sha256: hash.digest("hex") };
}

/** All values are resolved privately after the same allocation ledger is read. */
export async function prepareDatabaseCellDiagnostic(
  kit: DatabaseCellBootstrapKit,
  binding: DatabaseCellBinding,
  actuatorBuildSha: string
): Promise<DatabaseCellDiagnosticReceipt> {
  const diagnostic = kit.diagnostic;
  if (
    !diagnostic ||
    binding.phase !== "ready" ||
    binding.environment !== "production" ||
    kit.environment !== "production" ||
    kit.nodeId !== binding.nodeId ||
    kit.nodeSlug !== binding.nodeSlug ||
    kit.sourceSha !== actuatorBuildSha ||
    binding.sourceSha !== actuatorBuildSha ||
    binding.endpoint.tlsMode !== "verify-full" ||
    isIP(binding.endpoint.host) ||
    diagnostic.sourceDatabaseName !== binding.databaseName ||
    diagnostic.databaseName !== `${binding.databaseName}_diagnostic` ||
    diagnostic.replayRole !==
      `replay_${diagnostic.databaseName.slice("cogni_".length)}` ||
    [diagnostic.databaseName, diagnostic.replayRole].some(
      (name) => !/^[a-z][a-z0-9_]{0,62}$/.test(name)
    )
  ) {
    throw new AkashTxError(
      "invalid_request",
      "private diagnostic scope unavailable"
    );
  }
  const root = privateClient(kit, binding, "postgres");
  let source: ReturnType<typeof postgres> | undefined;
  let clone: ReturnType<typeof postgres> | undefined;
  try {
    await root`SELECT pg_advisory_lock(hashtext(${`cell-diagnostic:${binding.receiptId}`}))`;
    const [system] =
      await root`SELECT system_identifier::text AS id FROM pg_control_system()`;
    if (system?.id !== binding.systemIdentifier)
      throw new Error("cell native identity mismatch");
    const [incident] =
      await root`SELECT count(*) AS count FROM cogni_control.database_recoveries
      WHERE node_id=${binding.nodeId}::uuid AND environment=${binding.environment} AND is_current
      AND state='contained' AND database_name=${binding.databaseName}
      AND database_system_identifier=${binding.systemIdentifier}
      AND target_build_sha=${diagnostic.targetBuildSha}`;
    const [fence] = await root`SELECT count(*)=2 AND bool_and(NOT rolcanlogin)
      AND NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename IN (${binding.appRole},${binding.serviceRole})) AS valid
      FROM pg_roles WHERE rolname IN (${binding.appRole},${binding.serviceRole})`;
    if (Number(incident?.count) !== 1 || fence?.valid !== true)
      throw new Error("parent cell lacks qualified fence");
    source = privateClient(kit, binding, binding.databaseName);
    const original = await fingerprint(source);
    await source.end({ timeout: 5 });
    source = undefined;
    if (BigInt(original.rows) === 0n)
      throw new Error("representative diagnostic source is empty");
    const [existing] =
      await root`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${diagnostic.databaseName}) AS present`;
    if (!existing?.present) {
      const [sessions] =
        await root`SELECT count(*) AS count FROM pg_stat_activity WHERE datname=${binding.databaseName}`;
      if (Number(sessions?.count) !== 0)
        throw new Error("source clone has active sessions");
      await root.unsafe(
        `CREATE DATABASE ${identifier(diagnostic.databaseName)} TEMPLATE ${identifier(binding.databaseName)} OWNER postgres`
      );
    }
    clone = privateClient(kit, binding, diagnostic.databaseName);
    const copied = await fingerprint(clone);
    if (original.rows !== copied.rows || original.sha256 !== copied.sha256)
      throw new Error("diagnostic clone differs from fenced source");
    const [role] =
      await root`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${diagnostic.replayRole}) AS present`;
    if (!role?.present)
      await root.unsafe(
        `CREATE ROLE ${identifier(diagnostic.replayRole)} NOLOGIN`
      );
    const [password] =
      await root`SELECT format('ALTER ROLE %I PASSWORD %L',${diagnostic.replayRole}::text,${diagnostic.replayPassword}::text) AS command`;
    await root.unsafe(String(password?.command));
    await root.unsafe(
      `ALTER ROLE ${identifier(diagnostic.replayRole)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 8`
    );
    for (const [key, value] of Object.entries({
      default_transaction_read_only: "on",
      statement_timeout: "2000ms",
      lock_timeout: "2000ms",
      idle_in_transaction_session_timeout: "30000ms",
      temp_file_limit: "128MB",
      work_mem: "16MB",
    })) {
      await root.unsafe(
        `ALTER ROLE ${identifier(diagnostic.replayRole)} SET ${key} = '${value}'`
      );
    }
    const grants =
      await clone`SELECT format('GRANT USAGE ON SCHEMA %I TO %I; GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I; GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',nspname,${diagnostic.replayRole}::text,nspname,${diagnostic.replayRole}::text,nspname,${diagnostic.replayRole}::text) AS command
      FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','cogni_control') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'`;
    for (const grant of grants) await clone.unsafe(String(grant.command));
    const [identityDefinition] = await clone`SELECT format(
      'CREATE OR REPLACE FUNCTION public.database_replay_identity() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS %L',
      format('BEGIN IF session_user <> %L THEN RAISE EXCEPTION ''scoped replay identity required'' USING ERRCODE=''42501''; END IF; RETURN (SELECT jsonb_build_object(''databaseName'',current_database(),''role'',session_user,''systemIdentifier'',system_identifier::text,''sourceSha'',%L) FROM pg_control_system()); END', ${diagnostic.replayRole}::text,${actuatorBuildSha}::text)) AS command`;
    await clone.unsafe(String(identityDefinition?.command));
    await clone.unsafe(
      `REVOKE ALL ON FUNCTION public.database_replay_identity() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.database_replay_identity() TO ${identifier(diagnostic.replayRole)}`
    );
    const [isolation] = await clone`SELECT
      NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=${diagnostic.replayRole}::regrole)
      AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' AND has_schema_privilege(${diagnostic.replayRole},oid,'CREATE'))
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(${diagnostic.replayRole},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND p.prosecdef AND p.oid <> 'public.database_replay_identity()'::regprocedure AND has_function_privilege(${diagnostic.replayRole},p.oid,'EXECUTE')) AS valid`;
    if (isolation?.valid !== true)
      throw new Error("diagnostic role privilege drift");
    await root.unsafe(`ALTER ROLE ${identifier(diagnostic.replayRole)} LOGIN`);
    return {
      version: 1,
      action: "diagnostic-clone",
      allocationReceiptId: binding.receiptId,
      nodeId: binding.nodeId,
      nodeSlug: binding.nodeSlug,
      environment: "production",
      provider: "akash",
      providerAccount: binding.providerAccount,
      dseq: binding.dseq,
      failureDomainId: binding.failureDomainId,
      systemIdentifier: binding.systemIdentifier,
      sourceSha: actuatorBuildSha,
      targetBuildSha: diagnostic.targetBuildSha,
      sourceDatabaseName: binding.databaseName,
      databaseName: diagnostic.databaseName,
      replayRole: diagnostic.replayRole,
      connectionLimit: 8,
      statementTimeoutMs: 2000,
      verification: copied,
      completedAt: new Date().toISOString(),
    };
  } catch {
    // Driver failures may contain SQL/password parameters. They never leave custody.
    throw new AkashTxError(
      "provider_unavailable",
      "private cell diagnostic preparation failed"
    );
  } finally {
    await source?.end({ timeout: 5 });
    await clone?.end({ timeout: 5 });
    await root.end({ timeout: 5 });
  }
}

/** Fixed resource metadata read during all eight replay sessions; no ninth replay login. */
export async function observeDatabaseCellDiagnostic(
  kit: DatabaseCellBootstrapKit,
  binding: DatabaseCellBinding,
  actuatorBuildSha: string
) {
  if (
    !kit.diagnostic ||
    binding.phase !== "ready" ||
    binding.environment !== "production" ||
    kit.nodeId !== binding.nodeId ||
    kit.sourceSha !== actuatorBuildSha ||
    binding.sourceSha !== actuatorBuildSha ||
    binding.endpoint.tlsMode !== "verify-full" ||
    isIP(binding.endpoint.host)
  )
    throw new AkashTxError(
      "invalid_request",
      "private diagnostic scope unavailable"
    );
  const root = privateClient(kit, binding, kit.diagnostic.databaseName, 5000);
  try {
    const [identity] =
      await root`SELECT system_identifier::text AS id FROM pg_control_system()`;
    const [fence] = await root`SELECT count(*)=2 AND bool_and(NOT rolcanlogin)
      AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename IN (${binding.appRole},${binding.serviceRole})) AS valid
      FROM pg_roles WHERE rolname IN (${binding.appRole},${binding.serviceRole})`;
    const [role] = await root`SELECT rolconnlimit AS limit,rolcanlogin AS login,
        rolbypassrls AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolinherit
        AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=role.oid AND setdatabase<>0)
        AND rolconfig @> ARRAY['default_transaction_read_only=on','statement_timeout=2000ms',
          'lock_timeout=2000ms','idle_in_transaction_session_timeout=30000ms','temp_file_limit=128MB','work_mem=16MB']
        AND NOT has_database_privilege(rolname,current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' AND has_schema_privilege(rolname,oid,'CREATE'))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(rolname,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(rolname,c.oid,'USAGE,UPDATE') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND p.prosecdef AND p.oid<>'public.database_replay_identity()'::regprocedure AND has_function_privilege(rolname,p.oid,'EXECUTE')) AS isolated
        FROM pg_roles role WHERE rolname=${kit.diagnostic.replayRole}`;
    const [sessions] =
      await root`SELECT count(*) AS count FROM pg_stat_activity WHERE usename=${kit.diagnostic.replayRole}`;
    const [snapshot] =
      await root`WITH snapshot AS (SELECT pg_read_file('/run/database-cell/health.json',0,4096)::jsonb AS health)
      SELECT health, (health->>'observedAt')::timestamptz <= clock_timestamp()
        AND (health->>'observedAt')::timestamptz >= clock_timestamp()-interval '5 seconds' AS fresh FROM snapshot`;
    const percent = z.number().min(0).max(100);
    const health = z
      .object({
        version: z.literal(1),
        scope: z.literal("dedicated-cell"),
        sourceSha: z.literal(actuatorBuildSha),
        observedAt: z.string().datetime(),
        ioPressurePct: percent,
        connectionPct: percent,
        memoryHeadroomPct: percent,
        diskHeadroomPct: percent,
      })
      .strict()
      .parse(snapshot?.health);
    if (
      identity?.id !== binding.systemIdentifier ||
      fence?.valid !== true ||
      role?.limit !== 8 ||
      role.login !== true ||
      role.isolated !== true ||
      snapshot?.fresh !== true ||
      !Number.isInteger(Number(sessions?.count)) ||
      Number(sessions?.count) < 0 ||
      Number(sessions?.count) > 8
    )
      throw new Error("diagnostic native identity or fence mismatch");
    return {
      version: 1,
      action: "diagnostic-status",
      nodeId: binding.nodeId,
      sourceSha: actuatorBuildSha,
      targetBuildSha: kit.diagnostic.targetBuildSha,
      systemIdentifier: binding.systemIdentifier,
      failureDomainId: binding.failureDomainId,
      parentRolesContained: true,
      parentRuntimeSessions: 0,
      replayRole: kit.diagnostic.replayRole,
      replayConnections: Number(sessions?.count),
      connectionLimit: role.limit,
      cellSubstrate: health,
      observedAt: new Date().toISOString(),
    };
  } catch {
    throw new AkashTxError(
      "provider_unavailable",
      "private diagnostic observation failed"
    );
  } finally {
    await root.end({ timeout: 5 });
  }
}
