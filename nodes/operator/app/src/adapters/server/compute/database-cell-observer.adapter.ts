// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/database-cell-observer.adapter`
 * Purpose: Qualify fixed cell backup ACLs and read isolated native identity using owned cell credentials.
 * Scope: Fixed zero-argument qualification and bounded reads; does not accept arbitrary SQL or change runtime LOGIN.
 * Invariants: TLS verifies the actual observed DNS endpoint against the cell's unique CA; every client closes before return.
 * Side-effects: IO (fixed backup ACL qualification and scoped native reads)
 * Links: shared/secrets/database-cell-binding.data.ts, control-migrations/0001_database_recovery_watchdog.sql
 * @internal
 */
import postgres from "postgres";
import { z } from "zod";

import type { DatabaseCellBootstrapKit } from "@/shared/secrets/database-cell-binding.data";

const ObservationSchema = z
  .object({
    database: z.string(),
    role: z.string(),
    systemIdentifier: z.string().regex(/^[0-9]+$/),
    serverPort: z.literal(5432),
    probeRoleIsolated: z.literal(true),
    runtimeRolesPresent: z.literal(true),
    runtimeRolesNoLogin: z.boolean(),
    appRolesCanLogin: z.boolean(),
    activeRuntimeSessions: z.number().int().nonnegative(),
    systemTenantExists: z.boolean(),
    cellSubstrate: z
      .object({
        sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
        systemIdentifier: z.string().regex(/^[0-9]+$/),
      })
      .passthrough(),
  })
  .passthrough();
const IncidentSchema = z
  .object({
    nodeId: z.string().uuid(),
    nodeSlug: z.string(),
    environment: z.string(),
    incidentId: z.string(),
    targetBuildSha: z.string(),
    databaseSystemIdentifier: z.string(),
    databaseName: z.string(),
    appRole: z.string(),
    serviceRole: z.string(),
    state: z.string(),
  })
  .passthrough();

export class PostgresDatabaseCellObserver {
  async observe(
    kit: DatabaseCellBootstrapKit,
    endpoint: { host: string; port: number }
  ) {
    const connect = (role: string, password: string, database: string) =>
      postgres({
        host: endpoint.host,
        port: endpoint.port,
        username: role,
        password,
        database,
        ssl: { ca: kit.tlsCaCertificate, rejectUnauthorized: true },
        max: 1,
        connect_timeout: 5,
        idle_timeout: 1,
        connection: { statement_timeout: 5000, lock_timeout: 2000 },
      });
    const admin = connect(
      "database_reliability_actuator",
      kit.actuatorPassword,
      "postgres"
    );
    let incidents: z.infer<typeof IncidentSchema>[];
    try {
      const rows =
        await admin`SELECT public.list_database_recoveries() AS incident`;
      incidents = rows.map((row) => IncidentSchema.parse(row.incident));
    } finally {
      await admin.end({ timeout: 1 });
    }
    const proofs = [];
    for (const lane of kit.logicalDatabases) {
      const qualifier = connect(
        "postgres",
        kit.rootPassword,
        lane.databaseName
      );
      try {
        await qualifier`SELECT cogni_control.database_cell_qualify()`;
      } finally {
        await qualifier.end({ timeout: 1 });
      }
      const probe = connect(
        lane.probeRole,
        lane.probePassword,
        lane.databaseName
      );
      try {
        const rows =
          await probe`SELECT public.database_recovery_probe() AS observation`;
        const observation = ObservationSchema.parse(rows[0]?.observation);
        const matching = incidents.filter(
          (incident) =>
            incident.nodeId === kit.nodeId &&
            incident.environment === lane.environment
        );
        const incident = matching[0];
        if (
          matching.length !== 1 ||
          !incident ||
          observation.database !== lane.databaseName ||
          observation.role !== lane.probeRole ||
          observation.cellSubstrate.sourceSha !== kit.sourceSha ||
          observation.cellSubstrate.systemIdentifier !==
            observation.systemIdentifier ||
          incident.nodeSlug !== kit.nodeSlug ||
          incident.databaseName !== lane.databaseName ||
          incident.appRole !== lane.appRole ||
          incident.serviceRole !== lane.serviceRole ||
          incident.databaseSystemIdentifier !== observation.systemIdentifier ||
          incident.targetBuildSha !== lane.sourceSha
        )
          throw new Error(
            "cell native identity differs from its scoped bootstrap"
          );
        let backupQualified = false;
        if (
          lane.environment === "production" &&
          observation.systemTenantExists
        ) {
          const backup = connect(
            lane.backupRole,
            lane.backupPassword,
            lane.databaseName
          );
          try {
            const rows =
              await backup`SELECT public.database_backup_identity() AS identity`;
            const identity = z
              .object({
                databaseName: z.literal(lane.databaseName),
                role: z.literal(lane.backupRole),
                systemIdentifier: z.literal(observation.systemIdentifier),
                backupRoleIsolated: z.literal(true),
                allTablesReadable: z.literal(true),
              })
              .parse(rows[0]?.identity);
            backupQualified =
              identity.backupRoleIsolated && identity.allTablesReadable;
          } finally {
            await backup.end({ timeout: 1 });
          }
        }
        proofs.push({
          lane,
          observation: { ...observation, backupQualified },
          incident,
        });
      } finally {
        await probe.end({ timeout: 1 });
      }
    }
    if (
      new Set(proofs.map((proof) => proof.observation.systemIdentifier))
        .size !== 1
    )
      throw new Error(
        "logical cell lanes resolve to different physical clusters"
      );
    return proofs;
  }
}
