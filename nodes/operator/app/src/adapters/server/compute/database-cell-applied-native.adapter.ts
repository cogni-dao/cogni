// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@adapters/server/compute/database-cell-applied-native.adapter`
 * Purpose: Read an already admitted database cell through its existing scoped credentials.
 * Scope: Fixed SELECTs in read-only transactions; no grants, qualification functions, or role changes.
 * Invariants: Physical identity and peer certificate come from the same verified TLS connection.
 * Side-effects: Bounded DNS/TCP/Postgres reads, sequential single-connection clients.
 * Links: ports/database-cell-binding.port.ts, types/database-cell.ts
 * @internal
 */
import { createHash, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

import postgres from "postgres";
import { z } from "zod";
import { DatabaseCellAppliedCustodySchema } from "@/shared/secrets/database-cell-binding.data";
import type {
  DatabaseCellAppliedCustody,
  DatabaseCellAppliedRegistrationFacts,
} from "@/types/database-cell";
import {
  canonicalEvidenceJson,
  evidenceSha256,
} from "./database-cell-applied-artifacts";

const RoleSchema = z.object({
  name: z.string(),
  canLogin: z.boolean(),
  connectionLimit: z.coerce.number().int(),
  statementTimeoutMs: z.coerce.number().nonnegative(),
  lockTimeoutMs: z.coerce.number().nonnegative(),
  idleInTransactionTimeoutMs: z.coerce.number().nonnegative(),
  tempFileLimitMiB: z.coerce.number(),
  workMemMiB: z.coerce.number().positive(),
  roleReadOnly: z.boolean(),
});
const SessionSchema = z.object({
  role: z.string().min(1),
  applicationName: z.string().min(1),
  peerAddress: z.string().refine((value) => isIP(value) !== 0),
  count: z.number().int().positive(),
});
const RoleObservationSchema = RoleSchema.extend({
  sessions: z.array(SessionSchema),
});
const NativeSchema = z.object({
  database: z.string(),
  role: z.string(),
  systemIdentifier: z.string().regex(/^\d+$/),
  serverVersionNum: z.coerce.number().int(),
  serverPort: z.literal(5432),
  transactionReadOnly: z.literal("on"),
  activeRuntimeSessions: z.coerce.number().int().nonnegative(),
  tls: z.literal(true),
  probeSuperuser: z.literal(false),
  probeBypassRls: z.literal(false),
  probeDefaultReadOnly: z.literal(true),
});
const address = (value: string) => value.replace(/^::ffff:/, "");

/** PG15 exposes session identities to all roles; backend details may be hidden.
 * Count every other authenticated session, including spoofed observer names.
 */
export async function countOtherAuthenticatedSessions(
  tx: postgres.TransactionSql
): Promise<number> {
  const rows = await tx`SELECT count(*)::int AS count FROM pg_stat_activity
    WHERE usesysid IS NOT NULL AND pid<>pg_backend_pid()`;
  return z.coerce.number().int().nonnegative().parse(rows[0]?.count);
}

/** Credentials are provided by the bootstrap-owned custody reader, never the route caller. */
export async function observeAppliedDatabaseCellNative(input: {
  custody: DatabaseCellAppliedCustody;
  appEgressIp: string;
  expectedRuntimeApplications: DatabaseCellAppliedRegistrationFacts["manualCutover"]["expectedRuntimeApplications"];
  providerEndpoint: { host: string; port: number };
  observeMigrationJournal?: boolean;
  requireAbsentBusinessWriters?: true;
  expectedRelations?: readonly string[];
}): Promise<{
  native: DatabaseCellAppliedRegistrationFacts["native"];
  runtimeAdoption: DatabaseCellAppliedRegistrationFacts["effectiveApp"]["runtimeAdoption"];
}> {
  const custody = DatabaseCellAppliedCustodySchema.parse(input.custody);
  const { providerEndpoint } = input;
  if (!custody.readOnlyProbe)
    throw new Error("applied_cell_readonly_probe_custody_missing");
  const canonicalHost = custody.canonicalEndpointHost;
  if (!isIP(input.appEgressIp))
    throw new Error("applied_cell_app_egress_invalid");
  const [canonical, provider] = await Promise.all([
    lookup(canonicalHost, { all: true }),
    lookup(providerEndpoint.host, { all: true }),
  ]);
  const canonicalAddresses = [
    ...new Set(canonical.map((x) => address(x.address))),
  ];
  const providerAddresses = [
    ...new Set(provider.map((x) => address(x.address))),
  ];
  const allowed = canonicalAddresses.filter((x) =>
    providerAddresses.includes(x)
  );
  if (!allowed.length) throw new Error("applied_cell_dns_provider_mismatch");
  const expectedCertificate = new X509Certificate(custody.tlsCertificate);
  const certificateSha256 = createHash("sha256")
    .update(expectedCertificate.raw)
    .digest("hex");

  function client(dsn: string, expectedRole?: string) {
    const url = new URL(dsn);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== canonicalHost ||
      Number(url.port || 5432) !== providerEndpoint.port ||
      decodeURIComponent(url.pathname.slice(1)) !== custody.databaseName ||
      (expectedRole && decodeURIComponent(url.username) !== expectedRole) ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      [...url.searchParams.keys()].some((key) => key !== "sslmode")
    )
      throw new Error("applied_cell_dsn_scope_mismatch");
    let peerCertificateSha256: string | undefined;
    let authenticatedHostname: string | undefined;
    const sql = postgres({
      host: canonicalHost,
      port: providerEndpoint.port,
      database: custody.databaseName,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      max: 1,
      connect_timeout: 8,
      idle_timeout: 1,
      prepare: false,
      // Preserve effective role GUCs: startup overrides would falsify measured bounds/readOnly.
      connection: { application_name: "cogni_applied_cell_readonly_observer" },
      ...{
        socket: () =>
          new Promise<Socket>((resolve, reject) => {
            const socket = connect({
              host: canonicalHost,
              port: providerEndpoint.port,
            }) as Socket & { host: string };
            // postgres-js wraps this same socket after its PostgreSQL SSLRequest. The host
            // remains the certificate identity rather than the raw peer's IP address.
            socket.host = canonicalHost;
            socket.once("error", reject);
            socket.once("connect", () => {
              if (
                !socket.remoteAddress ||
                !allowed.includes(address(socket.remoteAddress))
              ) {
                socket.destroy();
                reject(new Error("applied_cell_actual_peer_dns_mismatch"));
              } else resolve(socket);
            });
          }),
      },
      ssl: {
        rejectUnauthorized: true,
        servername: canonicalHost,
        ...(custody.tls.kind === "private-ca"
          ? { ca: custody.tls.caCertificate }
          : {}),
        checkServerIdentity: (hostname: string, cert: PeerCertificate) => {
          const error = checkServerIdentity(canonicalHost, cert);
          if (error) return error;
          if (hostname !== canonicalHost)
            return new Error("applied_cell_tls_hostname_mismatch");
          authenticatedHostname = hostname;
          peerCertificateSha256 = createHash("sha256")
            .update(cert.raw)
            .digest("hex");
          if (peerCertificateSha256 !== certificateSha256)
            return new Error("applied_cell_tls_leaf_mismatch");
          return undefined;
        },
      },
    });
    return {
      sql,
      role: decodeURIComponent(url.username),
      certificate: () => {
        if (!peerCertificateSha256 || authenticatedHostname !== canonicalHost)
          throw new Error("applied_cell_same_connection_tls_evidence_missing");
        return peerCertificateSha256;
      },
    };
  }

  // Scope and physical identity are read first with the existing dedicated probe grant.
  const probe = client(custody.readOnlyProbe.dsn);
  let native: z.infer<typeof NativeSchema>;
  let peerCertificateDerSha256: string;
  let nativeObservedAt: string;
  let migrationJournal: DatabaseCellAppliedRegistrationFacts["native"]["migrationJournal"];
  try {
    native = await probe.sql.begin("read only", async (tx) => {
      const rows =
        await tx`SELECT current_database() AS database, session_user AS role,
        (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
        current_setting('server_version_num') AS "serverVersionNum",
        inet_server_port() AS "serverPort", current_setting('transaction_read_only') AS "transactionReadOnly",
        (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
        (SELECT count(*)::int FROM pg_stat_activity WHERE usename IN (${custody.appRole}, ${custody.serviceRole})) AS "activeRuntimeSessions",
        (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS "probeSuperuser",
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = session_user) AS "probeBypassRls",
        (current_setting('default_transaction_read_only') = 'on') AS "probeDefaultReadOnly"`;
      const identity = NativeSchema.parse(rows[0]);
      if (
        identity.database !== custody.databaseName ||
        identity.role !== probe.role
      )
        throw new Error("applied_cell_native_scope_mismatch");
      if (input.requireAbsentBusinessWriters) {
        const writers = await countOtherAuthenticatedSessions(tx);
        if (identity.activeRuntimeSessions !== 0 || writers !== 0)
          throw new Error("physical_import_business_sessions_present");
        const relations =
          await tx`SELECT schemaname || '.' || tablename AS name FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1 LIMIT 10001`;
        const names = relations.map((row) => String(row.name));
        const expected = [...(input.expectedRelations ?? [])].sort();
        if (
          names.length > 10000 ||
          !expected.length ||
          JSON.stringify(names.sort()) !== JSON.stringify(expected)
        )
          throw new Error("physical_import_current_catalog_mismatch");
      }
      if (input.observeMigrationJournal) {
        const journal =
          await tx`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id LIMIT 1025`;
        if (journal.length > 1024)
          throw new Error("applied_current_journal_exceeds_bound");
        const values = z
          .array(
            z.object({
              id: z.coerce.number().int().nonnegative(),
              hash: z.string(),
              created_at: z.union([z.string(), z.number()]).transform(String),
            })
          )
          .parse(journal);
        migrationJournal = {
          rowCount: values.length,
          sha256: evidenceSha256(canonicalEvidenceJson(values)),
          observedAt: new Date().toISOString(),
        };
      }
      return identity;
    });
    peerCertificateDerSha256 = probe.certificate();
    nativeObservedAt = new Date().toISOString();
    if (native.database !== custody.databaseName || native.role !== probe.role)
      throw new Error("applied_cell_native_scope_mismatch");
  } finally {
    await probe.sql.end({ timeout: 1 });
  }

  const sessions: z.infer<typeof SessionSchema>[] = [];
  const runtimeRoles: DatabaseCellAppliedRegistrationFacts["native"]["runtimeRoles"][number][] =
    [];
  // Close each role client before opening the next; the service role has a strict pool budget.
  for (const [dsn, expectedRole] of [
    [custody.app.dsn, custody.appRole],
    [custody.service.dsn, custody.serviceRole],
  ] as const) {
    const roleClient = client(dsn, expectedRole);
    try {
      const role = await roleClient.sql.begin("read only", async (tx) => {
        const rows = await tx`SELECT session_user AS name,
          (SELECT rolcanlogin FROM pg_roles WHERE rolname = session_user) AS "canLogin",
          (SELECT rolconnlimit FROM pg_roles WHERE rolname = session_user) AS "connectionLimit",
          (SELECT setting::numeric FROM pg_settings WHERE name = 'statement_timeout') AS "statementTimeoutMs",
          (SELECT setting::numeric FROM pg_settings WHERE name = 'lock_timeout') AS "lockTimeoutMs",
          (SELECT setting::numeric FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout') AS "idleInTransactionTimeoutMs",
          (SELECT setting::numeric / 1024 FROM pg_settings WHERE name = 'temp_file_limit') AS "tempFileLimitMiB",
          (SELECT setting::numeric / 1024 FROM pg_settings WHERE name = 'work_mem') AS "workMemMiB",
          (current_setting('default_transaction_read_only') = 'on') AS "roleReadOnly",
          (SELECT coalesce(json_agg(json_build_object('role',session_user,'applicationName',grouped.application_name,'peerAddress',grouped.peer,'count',grouped.sessions)), '[]'::json)
            FROM (SELECT application_name,host(client_addr) AS peer,count(*)::int AS sessions
              FROM pg_stat_activity WHERE datname=current_database() AND usename=session_user
                AND application_name <> 'cogni_applied_cell_readonly_observer'
              GROUP BY application_name,client_addr) AS grouped) AS sessions`;
        return RoleObservationSchema.parse(rows[0]);
      });
      roleClient.certificate();
      if (role.name !== expectedRole)
        throw new Error("applied_cell_runtime_role_mismatch");
      sessions.push(...role.sessions);
      runtimeRoles.push(RoleSchema.parse(role));
    } finally {
      await roleClient.sql.end({ timeout: 1 });
    }
  }
  if (
    input.requireAbsentBusinessWriters
      ? sessions.length !== 0
      : !sessions.length
  )
    throw new Error("applied_cell_business_session_state_mismatch");
  const expected = z
    .array(
      z.object({ role: z.string().min(1), applicationName: z.string().min(1) })
    )
    .min(1)
    .parse(input.expectedRuntimeApplications);
  if (
    expected.some(
      (item) =>
        ![custody.appRole, custody.serviceRole].includes(item.role) ||
        item.applicationName === "cogni_applied_cell_readonly_observer"
    ) ||
    sessions.some(
      (session) =>
        !expected.some(
          (item) =>
            item.role === session.role &&
            item.applicationName === session.applicationName
        )
    )
  )
    throw new Error("applied_cell_actual_named_app_sessions_unqualified");

  return {
    native: {
      databaseName: native.database,
      systemIdentifier: native.systemIdentifier,
      appRole: custody.appRole,
      serviceRole: custody.serviceRole,
      runtimeRoles,
      ...(migrationJournal ? { migrationJournal } : {}),
      activeRuntimeSessions: native.activeRuntimeSessions,
      serverVersionNum: native.serverVersionNum,
      tlsTrustKind: custody.tls.kind,
      endpointIdentity: {
        observedAt: new Date().toISOString(),
        provider: {
          host: providerEndpoint.host,
          port: providerEndpoint.port,
          addresses: providerAddresses,
        },
        canonical: {
          host: canonicalHost,
          port: providerEndpoint.port,
          addresses: canonicalAddresses,
        },
        peerCertificateDerSha256,
        systemIdentifier: native.systemIdentifier,
      },
    },
    runtimeAdoption: {
      observedAt: nativeObservedAt,
      systemIdentifier: native.systemIdentifier,
      publicBootEgressIp: input.appEgressIp,
      sessions,
    },
  };
}
