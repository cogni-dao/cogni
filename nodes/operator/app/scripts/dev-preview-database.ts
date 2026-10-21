// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Narrow fixture support for the supervised two-slot TEST pilot, never a provisioner.
 * The caller supplies the existing test admin execution and real closure/Job observations.
 * No credentials, role creation, password changes, base-node reset or migration copies.
 * Run the immutable image's declared migrators after reset, passing resetGeneration to
 * KubernetesMigrationJobAdapter; persist their receipts against that generation.
 */
import { randomUUID } from "node:crypto";

const HOST = "84.32.149.0";
const NODE_ID = "d520f82e-486a-40f1-9e4f-c8ef7a016e9a";
const APP_ROLE = "app_spawny_boi";
const SERVICE_ROLE = "service_spawny_boi";
const MIGRATION_ROLE = "migration_spawny_boi";

export interface DevPreviewDatabasePair {
  readonly stateSlot: 0 | 1;
  readonly nodeId: typeof NODE_ID;
  readonly host: typeof HOST;
  readonly postgresDatabase: string;
  readonly doltgresDatabase: string;
}

export function devPreviewDatabasePair(slot: 0 | 1): DevPreviewDatabasePair {
  if (slot !== 0 && slot !== 1)
    throw new Error("INVALID_PREVIEW_DATABASE_SLOT");
  const suffix = slot === 0 ? "a" : "b";
  return {
    stateSlot: slot,
    nodeId: NODE_ID,
    host: HOST,
    postgresDatabase: `cogni_spawny_boi_preview_${suffix}`,
    doltgresDatabase: `knowledge_spawny_boi_preview_${suffix}`,
  };
}

/** Reuse the selected node's exact existing credential/transport; change only contents. */
export function devPreviewDatabaseUrls(
  slot: 0 | 1,
  source: {
    app: string;
    service: string;
    migration: string;
    doltgres: string;
  }
): typeof source {
  const pair = devPreviewDatabasePair(slot);
  const rewrite = (
    value: string,
    role: string,
    port: string,
    base: string,
    target: string
  ) => {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== HOST ||
      url.port !== port ||
      decodeURIComponent(url.username) !== role ||
      !url.password ||
      ![base, target].includes(url.pathname.slice(1)) ||
      url.searchParams.get("sslmode") !== "disable"
    )
      throw new Error("TEST_DATABASE_BINDING_MISMATCH");
    url.pathname = `/${target}`;
    return url.toString();
  };
  return {
    app: rewrite(
      source.app,
      APP_ROLE,
      "5432",
      "cogni_spawny_boi",
      pair.postgresDatabase
    ),
    service: rewrite(
      source.service,
      SERVICE_ROLE,
      "5432",
      "cogni_spawny_boi",
      pair.postgresDatabase
    ),
    migration: rewrite(
      source.migration,
      MIGRATION_ROLE,
      "5432",
      "cogni_spawny_boi",
      pair.postgresDatabase
    ),
    doltgres: rewrite(
      source.doltgres,
      "postgres",
      "5435",
      "knowledge_spawny_boi",
      pair.doltgresDatabase
    ),
  };
}

export interface DevPreviewDatabaseResetRecord extends DevPreviewDatabasePair {
  readonly deploymentId: string;
  readonly resetGeneration: string;
  readonly resetStartedAt: string;
  readonly phase: "resetting" | "empty";
}

export interface DevPreviewDatabaseResetDeps {
  /**
   * Serialize with provider create for this admission through the complete operation.
   * Reject current in-flight/active allocations; merely owning the slot is insufficient.
   * Validate supplied previous-handle history against the admission before invoking action.
   */
  withReservedUnallocatedPair<T>(
    slot: 0 | 1,
    deploymentId: string,
    previousExternalName: string | undefined,
    action: () => Promise<T>
  ): Promise<T>;
  /** Positive provider closure read; DELETE acknowledgment or ledger released is insufficient. */
  observePreviousLease(
    externalName: string
  ): Promise<"closed" | "unknown" | "active">;
  /** Fresh Job AND Pod observation, including Pending/terminating writers, scoped by DB binding. */
  assertNoMigrationWriters(pair: DevPreviewDatabasePair): Promise<void>;
  /** Durable metadata before destructive SQL. A failed/partial reset remains unavailable. */
  save(record: DevPreviewDatabaseResetRecord): Promise<void>;
  /** Existing native TEST admin seam only; database targets are hardcoded below. */
  sql(
    engine: "postgres" | "doltgres",
    database: string,
    statement: string
  ): Promise<string>;
}

/**
 * Recreate only these two explicitly allowlisted disposable pairs, with original node roles.
 * Caller must retain the admission slot until provider closure and migration quiescence.
 * No FORCE: an unexpected PostgreSQL consumer makes DROP fail rather than killing sessions.
 */
export async function resetDevPreviewDatabasePair(
  input: {
    stateSlot: 0 | 1;
    deploymentId: string;
    previousExternalName?: string;
  },
  deps: DevPreviewDatabaseResetDeps
): Promise<DevPreviewDatabaseResetRecord> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.deploymentId))
    throw new Error("INVALID_DEPLOYMENT_ID");
  const pair = devPreviewDatabasePair(input.stateSlot);
  return deps.withReservedUnallocatedPair(
    input.stateSlot,
    input.deploymentId,
    input.previousExternalName,
    async () => {
      if (
        input.previousExternalName &&
        (await deps.observePreviousLease(input.previousExternalName)) !==
          "closed"
      ) {
        throw new Error("PREVIOUS_PREVIEW_CLOSURE_UNPROVEN");
      }
      if (!input.previousExternalName) {
        // Omitted history is valid only for genuinely absent, never-used pairs. An existing
        // empty database is still a used pair and cannot bypass the closure observation.
        const [pg, dolt] = await Promise.all([
          deps.sql(
            "postgres",
            "postgres",
            `SELECT datname FROM pg_database WHERE datname = '${pair.postgresDatabase}'`
          ),
          deps.sql(
            "doltgres",
            "postgres",
            `SELECT datname FROM pg_database WHERE datname = '${pair.doltgresDatabase}'`
          ),
        ]);
        if (pg.trim() || dolt.trim())
          throw new Error("PREVIOUS_PREVIEW_HISTORY_REQUIRED");
      }
      await deps.assertNoMigrationWriters(pair);
      const record: DevPreviewDatabaseResetRecord = {
        ...pair,
        deploymentId: input.deploymentId,
        resetGeneration: randomUUID(),
        resetStartedAt: new Date().toISOString(),
        phase: "resetting",
      };
      await deps.save(record);
      // No source database/table is copied. The image's own journals must migrate empty data.
      await deps.sql(
        "postgres",
        "postgres",
        `DROP DATABASE IF EXISTS "${pair.postgresDatabase}"`
      );
      await deps.sql(
        "postgres",
        "postgres",
        `CREATE DATABASE "${pair.postgresDatabase}" OWNER "${APP_ROLE}"`
      );
      await deps.sql(
        "postgres",
        "postgres",
        `ALTER ROLE "${MIGRATION_ROLE}" IN DATABASE "${pair.postgresDatabase}" SET role = '${APP_ROLE}'`
      );
      await deps.sql(
        "postgres",
        "postgres",
        `GRANT CONNECT, CREATE ON DATABASE "${pair.postgresDatabase}" TO "${SERVICE_ROLE}"`
      );
      await deps.sql(
        "postgres",
        pair.postgresDatabase,
        `GRANT USAGE, CREATE ON SCHEMA public TO "${APP_ROLE}", "${SERVICE_ROLE}"`
      );
      await deps.sql(
        "postgres",
        pair.postgresDatabase,
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${APP_ROLE}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${SERVICE_ROLE}"`
      );
      await deps.sql(
        "postgres",
        pair.postgresDatabase,
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${APP_ROLE}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${SERVICE_ROLE}"`
      );
      await deps.sql(
        "doltgres",
        "postgres",
        `DROP DATABASE IF EXISTS "${pair.doltgresDatabase}"`
      );
      await deps.sql(
        "doltgres",
        "postgres",
        `CREATE DATABASE "${pair.doltgresDatabase}"`
      );
      const complete: DevPreviewDatabaseResetRecord = {
        ...record,
        phase: "empty",
      };
      await deps.save(complete);
      return complete;
    }
  );
}
