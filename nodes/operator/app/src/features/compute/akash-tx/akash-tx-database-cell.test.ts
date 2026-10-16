// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";
import { DatabaseCellBootstrapKitsSchema } from "@/shared/secrets/database-cell-binding.data";
import { databaseCellSpecFactory } from "./akash-tx-database-cell";

const budget = {
  appConnectionLimit: 2,
  appStatementTimeoutMs: 5000,
  serviceConnectionLimit: 8,
  serviceStatementTimeoutMs: 2000,
  lockTimeoutMs: 2000,
  idleInTransactionTimeoutMs: 30000,
  tempFileLimitMiB: 128,
  workMemMiB: 16,
};
const nodeId = "00000000-0000-4000-8000-000000000001";
const password = "a".repeat(48);
const kit = {
  version: 1,
  nodeId,
  nodeSlug: "neutral",
  environment: "production",
  sourceSha: "a".repeat(40),
  rootPassword: password,
  actuatorPassword: password,
  readmitPassword: password,
  tlsCertificate: "-----BEGIN CERTIFICATE-----\nfixture",
  tlsCaCertificate: "-----BEGIN CERTIFICATE-----\nfixture CA",
  tlsPrivateKey: "-----BEGIN PRIVATE KEY-----\nfixture",
  logicalDatabases: ["candidate-a", "production"].map((environment) => {
    const suffix = `neutral_${environment.replaceAll("-", "_")}`;
    return {
      environment,
      databaseName: `cogni_${suffix}`,
      appRole: `app_${suffix}`,
      serviceRole: `service_${suffix}`,
      migrationRole: `migration_${suffix}`,
      probeRole: `probe_${suffix}`,
      backupRole: `backup_${suffix}`,
      sourceSha: "b".repeat(40),
      budgetProfile: "dedicated-high-throughput-v1",
      budget,
      appPassword: password,
      servicePassword: "b".repeat(48),
      migrationPassword: password,
      probePassword: password,
      backupPassword: "c".repeat(48),
    };
  }),
};
const assets = {
  bootstrap: "bootstrap bytes",
  provision: "provision bytes",
  control: "control bytes",
  migration0: "migration zero bytes",
  migration1: "watchdog bytes",
  lockingRetirement: "locking retirement bytes",
};
const reference = {
  nodeId,
  nodeSlug: "neutral",
  environment: "production",
  budgetProfile: "dedicated-high-throughput-v1",
};
const factory = () =>
  databaseCellSpecFactory(
    DatabaseCellBootstrapKitsSchema.parse([kit]),
    assets,
    { vcpus: 4, memoryGiB: 16, storageGiB: 100, budget },
    kit.sourceSha
  );

describe("private database cell factory", () => {
  it("renders persistent PG15 and every distinct lane from the private kit", () => {
    const spec = factory()(reference);
    const service = spec.services[0];
    if (!service) throw new Error("cell service missing");
    expect(service.image).toMatch(/^postgres:15@sha256:/);
    expect(service.cpuUnits).toBe(4);
    expect(service.memoryMi).toBe(16384);
    expect(service.volumes).toEqual([
      {
        name: "database",
        sizeMi: 102400,
        mountPath: "/var/lib/postgresql/data",
        tier: "nvme",
      },
    ]);
    expect(service.env?.COGNI_NODE_DBS).toBe(
      "cogni_neutral_candidate_a,cogni_neutral_production"
    );
    expect(service.env?.CELL_LANE_0_APP_DB_SERVICE_PASSWORD).toBe(
      "b".repeat(48)
    );
    expect(service.env?.CELL_LANE_1_APP_DB_PASSWORD).toBe(password);
    expect(service.env?.DATABASE_CELL_NODE_ID).toBe(nodeId);
    expect(service.env?.CELL_LANE_0_ENVIRONMENT).toBe("candidate-a");
    expect(service.env?.CELL_LANE_0_TARGET_BUILD_SHA).toBe("b".repeat(40));
    expect(service.env?.DATABASE_CELL_SOURCE_SHA).toBe("a".repeat(40));
    expect(
      Buffer.from(service.env?.CELL_ASSET_MIGRATION1 ?? "", "base64").toString()
    ).toBe(assets.migration1);
    expect(service.args?.[0]).toContain(
      "/app/control-migrations/0001_database_recovery_watchdog.sql"
    );
    expect(
      Buffer.from(
        service.env?.CELL_ASSET_LOCKINGRETIREMENT ?? "",
        "base64"
      ).toString()
    ).toBe(assets.lockingRetirement);
    expect(service.args?.[0]).toContain(
      "/app/control-migrations/0003_disable_database_locking.sql"
    );
    expect(service.expose).toEqual([{ port: 5432, as: 5432, global: true }]);
  });
  it("refuses a foreign node, physical environment, slug or profile before provider allocation", () => {
    for (const change of [
      { nodeId: "00000000-0000-4000-8000-000000000002" },
      { nodeSlug: "foreign" },
      { environment: "candidate-a" },
      { budgetProfile: "shared-default-v1" },
    ]) {
      expect(() => factory()({ ...reference, ...change })).toThrow(
        "canonical private cell kit missing"
      );
    }
  });
  it("refuses private kit budgets that differ from the immutable profile", () => {
    const poisoned = structuredClone(kit);
    const firstLane = poisoned.logicalDatabases[0];
    if (!firstLane) throw new Error("fixture lane missing");
    firstLane.budget = {
      ...budget,
      serviceConnectionLimit: 64,
    };
    const make = databaseCellSpecFactory(
      DatabaseCellBootstrapKitsSchema.parse([poisoned]),
      assets,
      { vcpus: 4, memoryGiB: 16, storageGiB: 100, budget },
      kit.sourceSha
    );
    expect(() => make(reference)).toThrow("immutable catalog budget");
  });
  it("refuses stale kit source provenance before any allocation", () => {
    const make = databaseCellSpecFactory(
      DatabaseCellBootstrapKitsSchema.parse([kit]),
      assets,
      { vcpus: 4, memoryGiB: 16, storageGiB: 100, budget },
      "c".repeat(40)
    );
    expect(() => make(reference)).toThrow(
      "bootstrap source differs from running actuator"
    );
    expect(() =>
      databaseCellSpecFactory(
        [],
        assets,
        { vcpus: 4, memoryGiB: 16, storageGiB: 100, budget },
        "short-sha"
      )
    ).toThrow("verified actuator build SHA");
  });
});
