// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  materializeDatabaseCellKits,
  planDatabaseCellKits,
} from "../../../../../../scripts/lib/materialize-database-cell-kits";
import {
  DatabaseCellBootstrapKitsSchema,
  DatabaseRecoveryCellAdminBindingSchema,
  DatabaseRecoveryCellProbeBindingSchema,
  DatabaseRecoveryCellReadmitBindingSchema,
} from "./database-cell-binding.data";

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
const nodeId = "11111111-1111-4111-8111-111111111111";
const source = {
  operatorSourceSha: "a".repeat(40),
  environment: "production",
  expectedSourceHost: "10.0.0.1",
  nativeSource: {
    systemIdentifier: "1234567890123456789",
    databases: ["cogni_alpha"],
    roles: ["app_alpha", "service_alpha"],
  },
  slots: [
    {
      nodeId,
      nodeSlug: "alpha",
      environment: "production",
      physicalEnvironment: "production",
      sourceSha: "b".repeat(40),
      budgetProfile: "dedicated-high-throughput-v1",
      budget,
      appDsn: "postgresql://app_alpha:fixture@10.0.0.1:5432/cogni_alpha",
      serviceDsn:
        "postgresql://service_alpha:fixture@10.0.0.1:5432/cogni_alpha",
    },
  ],
};

describe("canonical private database cells", () => {
  it("preserves actual source roles and separate operator/application source authority", () => {
    const plans = planDatabaseCellKits(source);
    expect(plans[0]?.sourceSha).toBe(source.operatorSourceSha);
    expect(plans[0]?.logicalDatabases[0]?.sourceSha).toBe(
      source.slots[0]?.sourceSha
    );
    expect(() =>
      planDatabaseCellKits({ ...source, expectedSourceHost: "10.0.0.2" })
    ).toThrow("residency");
    expect(() =>
      planDatabaseCellKits({
        ...source,
        nativeSource: { ...source.nativeSource, roles: [] },
      })
    ).toThrow("identity");
  });

  it("mints distinct lane credentials and a writer-only CA, then preserves exact material on retry", () => {
    const plans = planDatabaseCellKits(source);
    const result = materializeDatabaseCellKits({
      plans,
      existingKits: [],
      existingPublished: [],
      existingAuthorities: [],
    });
    const kit = result.nodeKits[0];
    if (!kit) throw new Error("missing kit");
    const authority = result.authorities[0];
    if (!authority) throw new Error("missing authority");
    expect(kit.logicalDatabases[0]?.appPassword).not.toBe(
      kit.logicalDatabases[0]?.servicePassword
    );
    expect(kit.logicalDatabases[0]?.backupRole).toBe("backup_alpha");
    expect(kit.logicalDatabases[0]?.backupPassword).not.toBe(kit.rootPassword);
    expect(kit.logicalDatabases[0]?.backupPassword).not.toBe(
      kit.logicalDatabases[0]?.appPassword
    );
    expect(kit.tlsPrivateKey).not.toBe(authority.tlsCaPrivateKey);
    expect(JSON.stringify(result.published)).not.toContain(
      authority.tlsCaPrivateKey
    );
    expect(
      materializeDatabaseCellKits({
        plans,
        existingKits: result.nodeKits,
        existingPublished: result.published,
        existingAuthorities: result.authorities,
      })
    ).toEqual(result);
    expect(
      DatabaseCellBootstrapKitsSchema.safeParse([
        { ...kit, tlsCaPrivateKey: "forbidden" },
      ]).success
    ).toBe(false);
    expect(() =>
      materializeDatabaseCellKits({
        plans,
        existingKits: result.nodeKits,
        existingPublished: result.published,
        existingAuthorities: [],
      })
    ).toThrow("partial");
  });

  it("enforces tagged DNS/port/TLS and separate control capability projections", () => {
    const common = {
      scope: "dedicated-cell",
      nodeId,
      nodeSlug: "alpha",
      environment: "production",
      databaseName: "cogni_alpha",
      probeRole: "probe_alpha",
      systemIdentifier: "1234567890123456789",
      substrateHost: `akash:akash1${"a".repeat(38)}:123`,
      sourceSha: "a".repeat(40),
      targetBuildSha: "b".repeat(40),
      endpoint: { host: "provider.example.org", port: 15432 },
      tlsCaCertificate: "-----BEGIN CERTIFICATE-----\nfixture",
    };
    const dsn = (role: string, db: string) =>
      `postgresql://${role}:fixture@provider.example.org:15432/${db}?sslmode=verify-full`;
    expect(
      DatabaseRecoveryCellProbeBindingSchema.safeParse({
        ...common,
        dsn: dsn("probe_alpha", "cogni_alpha"),
      }).success
    ).toBe(true);
    expect(
      DatabaseRecoveryCellAdminBindingSchema.safeParse({
        ...common,
        dsn: dsn("database_reliability_actuator", "postgres"),
      }).success
    ).toBe(true);
    expect(
      DatabaseRecoveryCellReadmitBindingSchema.safeParse({
        ...common,
        dsn: dsn("database_reliability_actuator", "postgres"),
      }).success
    ).toBe(false);
    expect(
      DatabaseRecoveryCellProbeBindingSchema.safeParse({
        ...common,
        endpoint: { host: "127.0.0.1", port: 15432 },
        dsn: dsn("probe_alpha", "cogni_alpha"),
      }).success
    ).toBe(false);
    expect(
      DatabaseRecoveryCellProbeBindingSchema.safeParse({
        ...common,
        dsn: `${dsn("probe_alpha", "cogni_alpha")}&host=other.example.org`,
      }).success
    ).toBe(false);
    expect(
      DatabaseRecoveryCellProbeBindingSchema.safeParse({
        ...common,
        dsn: dsn("probe_alpha", "cogni_alpha").replace("15432", "5432"),
      }).success
    ).toBe(false);
  });
});
