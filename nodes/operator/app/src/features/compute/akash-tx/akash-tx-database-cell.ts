// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Purpose: Render a fixed persistent PostgreSQL cell from the actuator's private kit.
 * Scope: Pure reference-to-spec factory; no provider calls, secret reads, or allocations.
 * Invariants: Caller secrets/spec overrides are absent; catalog budget and scoped kit agree.
 * Side-effects: none
 * Links: scripts/ops/database-cell-bootstrap.sh, database-cell-binding.data.ts
 */
import type { ProvisionSpec } from "@cogni/ai-tools";
import { COGNI_SYSTEM_BILLING_ACCOUNT_ID } from "@cogni/node-shared";
import { AkashTxError } from "@/ports";
import type { DatabaseCellBootstrapKit } from "@/shared/secrets/database-cell-binding.data";

export interface DatabaseCellProfile {
  readonly vcpus: number;
  readonly memoryGiB: number;
  readonly storageGiB: number;
  readonly budget: DatabaseCellBootstrapKit["logicalDatabases"][number]["budget"];
}

const ASSETS = {
  bootstrap: "/app/bootstrap.sh",
  provision: "/app/provision.sh",
  control: "/app/apply-control.sql",
  migration0: "/app/control-migrations/0000_database_recovery_control.sql",
  migration1: "/app/control-migrations/0001_database_recovery_watchdog.sql",
} as const;
export type DatabaseCellAssets = Readonly<Record<keyof typeof ASSETS, string>>;

const PG15_IMAGE =
  "postgres:15@sha256:1b92e7a80c021647bf70f5d3eb66066a998e4f5cf43c07bb9dc9f729782cf88e";

export function databaseCellSpecFactory(
  kits: readonly DatabaseCellBootstrapKit[],
  assets: DatabaseCellAssets,
  profile: DatabaseCellProfile,
  actuatorBuildSha: string
) {
  if (!/^[0-9a-f]{40}$/.test(actuatorBuildSha)) {
    throw new Error(
      "verified actuator build SHA is required for database cell assets"
    );
  }
  return (reference: {
    nodeId: string;
    nodeSlug: string;
    environment: string;
    budgetProfile: string;
  }): ProvisionSpec => {
    const kit = kits.find(
      (entry) =>
        entry.nodeId === reference.nodeId &&
        entry.nodeSlug === reference.nodeSlug &&
        entry.environment === reference.environment
    );
    if (!kit || reference.budgetProfile !== "dedicated-high-throughput-v1") {
      throw new AkashTxError(
        "invalid_request",
        "canonical private cell kit missing"
      );
    }
    if (kit.sourceSha !== actuatorBuildSha) {
      throw new AkashTxError(
        "invalid_request",
        "private cell kit bootstrap source differs from running actuator"
      );
    }
    for (const lane of kit.logicalDatabases) {
      if (
        lane.budgetProfile !== reference.budgetProfile ||
        Object.entries(profile.budget).some(
          ([key, value]) =>
            lane.budget[key as keyof typeof lane.budget] !== value
        )
      ) {
        throw new AkashTxError(
          "invalid_request",
          "cell kit differs from immutable catalog budget"
        );
      }
    }
    const env: Record<string, string> = {
      POSTGRES_ROOT_PASSWORD: kit.rootPassword,
      COGNI_SYSTEM_BILLING_ACCOUNT_ID,
      DATABASE_RELIABILITY_PASSWORD: kit.actuatorPassword,
      DATABASE_RELIABILITY_READMIT_PASSWORD: kit.readmitPassword,
      DATABASE_CELL_TLS_CERTIFICATE: kit.tlsCertificate,
      DATABASE_CELL_TLS_PRIVATE_KEY: kit.tlsPrivateKey,
      DATABASE_CELL_SOURCE_SHA: actuatorBuildSha,
      DATABASE_CELL_INDEXED_LANES: "1",
      COGNI_NODE_DBS: kit.logicalDatabases
        .map((lane) => lane.databaseName)
        .join(","),
      LITELLM_DB_NAME: "litellm",
      PGDATA: "/var/lib/postgresql/data/pgdata",
    };
    kit.logicalDatabases.forEach((lane, index) => {
      const fields = {
        APP_DB_PASSWORD: lane.appPassword,
        APP_DB_SERVICE_PASSWORD: lane.servicePassword,
        APP_DB_MIGRATION_PASSWORD: lane.migrationPassword,
        DATABASE_RECOVERY_PROBE_PASSWORD: lane.probePassword,
        DB_BUDGET_PROFILE: lane.budgetProfile,
        DB_APP_CONNECTION_LIMIT: lane.budget.appConnectionLimit,
        DB_APP_STATEMENT_TIMEOUT_MS: lane.budget.appStatementTimeoutMs,
        DB_SERVICE_CONNECTION_LIMIT: lane.budget.serviceConnectionLimit,
        DB_SERVICE_STATEMENT_TIMEOUT_MS: lane.budget.serviceStatementTimeoutMs,
        DB_LOCK_TIMEOUT_MS: lane.budget.lockTimeoutMs,
        DB_IDLE_IN_TRANSACTION_TIMEOUT_MS:
          lane.budget.idleInTransactionTimeoutMs,
        DB_TEMP_FILE_LIMIT_MIB: lane.budget.tempFileLimitMiB,
        DB_WORK_MEM_MIB: lane.budget.workMemMiB,
      };
      for (const [key, value] of Object.entries(fields)) {
        env[`CELL_LANE_${index}_${key}`] = String(value);
      }
    });
    const launch = ["set -eu", "umask 077", "mkdir -p /app/control-migrations"];
    for (const [key, path] of Object.entries(ASSETS)) {
      const variable = `CELL_ASSET_${key.toUpperCase()}`;
      env[variable] = Buffer.from(
        assets[key as keyof DatabaseCellAssets]
      ).toString("base64");
      launch.push(
        `printf '%s' "$${variable}" | base64 -d > ${path}`,
        `unset ${variable}`
      );
    }
    launch.push("exec bash /app/bootstrap.sh");
    return {
      name: `${kit.nodeSlug}-database-cell`,
      services: [
        {
          name: "postgres",
          image: PG15_IMAGE,
          cpuUnits: profile.vcpus,
          memoryMi: profile.memoryGiB * 1024,
          storageMi: 1024,
          volumes: [
            {
              name: "database",
              sizeMi: profile.storageGiB * 1024,
              mountPath: "/var/lib/postgresql/data",
              tier: "nvme",
            },
          ],
          command: ["bash", "-c"],
          args: [launch.join("\n")],
          env,
          expose: [{ port: 5432, as: 5432, global: true }],
        },
      ],
    };
  };
}
