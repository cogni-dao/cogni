// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { rootCertificates } from "node:tls";
import { describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("postgres", () => ({ default: clients.create }));

import {
  PostgresDatabaseRecoveryBeginAdapter,
  PostgresDatabaseRecoveryVerificationAdapter,
} from "./database-containment-production.adapter";
import {
  assertFreshCellSubstrate,
  createCellAdminRecoveryControls,
  createCellReadmitRecoveryControls,
  PostgresDatabaseCellRecoveryProbeAdapter,
  routeCellRecoveryBegin,
  routeCellRecoveryVerification,
} from "./database-recovery-cell.adapter";

const binding = {
  scope: "dedicated-cell",
  nodeId: "11111111-1111-4111-8111-111111111111",
  nodeSlug: "fixture",
  environment: "production" as const,
  databaseName: "cogni_fixture",
  probeRole: "probe_fixture",
  systemIdentifier: "123456789",
  substrateHost: `akash:akash1${"a".repeat(38)}:12`,
  sourceSha: "a".repeat(40),
  targetBuildSha: "b".repeat(40),
  endpoint: { host: "cell.example.org", port: 31415 },
  tlsCaCertificate: rootCertificates[0],
  dsn: "postgres://probe_fixture:fixture@cell.example.org:31415/cogni_fixture?sslmode=verify-full",
};

const snapshot = {
  version: 1,
  scope: "dedicated-cell",
  sourceSha: binding.sourceSha,
  observedAt: "2026-10-14T23:59:00Z",
  ioPressurePct: 0,
  connectionPct: 5,
  memoryHeadroomPct: 80,
  diskHeadroomPct: 90,
};

describe("dedicated recovery capability binding", () => {
  it("accepts assigned TLS port without weakening probe identity or shared routing", () => {
    const probe = new PostgresDatabaseCellRecoveryProbeAdapter([binding]);
    expect(probe.bindingFor(binding)).toMatchObject({
      endpoint: binding.endpoint,
      sourceSha: binding.sourceSha,
      targetBuildSha: binding.targetBuildSha,
    });
    expect(probe.bindingFor(binding)).not.toHaveProperty("dsn");
    expect(probe.bindingFor(binding)).not.toHaveProperty("tlsCaCertificate");
    for (const dsn of [
      binding.dsn.replace("31415", "5432"),
      `${binding.dsn}&host=foreign.example.org`,
      binding.dsn.replace("probe_fixture", "service_fixture"),
      binding.dsn.replace("verify-full", "require"),
    ])
      expect(
        () =>
          new PostgresDatabaseCellRecoveryProbeAdapter([{ ...binding, dsn }])
      ).toThrow();
  });

  it("passes the actual pinned CA to TLS and keeps readmit and actuator identities separate", () => {
    clients.create.mockReturnValue({});
    const admin = {
      ...binding,
      dsn: "postgres://database_reliability_actuator:fixture@cell.example.org:31415/postgres?sslmode=verify-full",
    };
    createCellAdminRecoveryControls([admin]);
    expect(clients.create).toHaveBeenCalledWith(
      "postgres://database_reliability_actuator:fixture@cell.example.org:31415/postgres",
      expect.objectContaining({
        ssl: { ca: binding.tlsCaCertificate, rejectUnauthorized: true },
        connect_timeout: 5,
        connection: { statement_timeout: 5000, lock_timeout: 2000 },
      })
    );
    expect(() => createCellReadmitRecoveryControls([admin])).toThrow();
    expect(() => createCellAdminRecoveryControls([admin, admin])).toThrow();
  });

  it("rejects a foreign target SHA or native system identity before any LOGIN/completion SQL", async () => {
    const unsafe = vi.fn();
    clients.create.mockReturnValue({ unsafe });
    const sharedQuery = vi.fn();
    const sharedSql = { query: sharedQuery };
    const adminDsn =
      "postgres://database_reliability_actuator:fixture@cell.example.org:31415/postgres?sslmode=verify-full";
    const readmitDsn = adminDsn.replace(
      "database_reliability_actuator",
      "database_reliability_readmitter"
    );
    const verify = routeCellRecoveryVerification(
      new PostgresDatabaseRecoveryVerificationAdapter(sharedSql),
      createCellAdminRecoveryControls([{ ...binding, dsn: adminDsn }])
    );
    const begin = routeCellRecoveryBegin(
      new PostgresDatabaseRecoveryBeginAdapter(sharedSql),
      createCellReadmitRecoveryControls([{ ...binding, dsn: readmitDsn }])
    );
    const identity = {
      nodeId: binding.nodeId,
      environment: binding.environment,
      targetBuildSha: binding.targetBuildSha,
      databaseSystemIdentifier: binding.systemIdentifier,
      incidentId: "reliability.v1:fixture",
    };
    await expect(
      verify.complete({ ...identity, targetBuildSha: binding.sourceSha })
    ).rejects.toThrow("mutation_identity_mismatch");
    await expect(
      verify.recontain({
        ...identity,
        databaseSystemIdentifier: "999999",
        reason: "fixture",
      })
    ).rejects.toThrow("mutation_identity_mismatch");
    await expect(
      begin.begin({
        ...identity,
        nodeSlug: "foreign",
        actorId: "human:fixture",
      })
    ).rejects.toThrow("mutation_identity_mismatch");
    expect(unsafe).not.toHaveBeenCalled();
    expect(sharedQuery).not.toHaveBeenCalled();
  });

  it("requires native cell measurements at the operator source SHA within five seconds", () => {
    const now = Date.parse(snapshot.observedAt) + 5_000;
    expect(assertFreshCellSubstrate(snapshot, binding.sourceSha, now)).toEqual(
      snapshot
    );
    expect(() =>
      assertFreshCellSubstrate(snapshot, binding.targetBuildSha, now)
    ).toThrow();
    expect(() =>
      assertFreshCellSubstrate(snapshot, binding.sourceSha, now + 1)
    ).toThrow();
    expect(() =>
      assertFreshCellSubstrate(snapshot, binding.sourceSha, now - 5_001)
    ).toThrow();
    for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 101])
      expect(() =>
        assertFreshCellSubstrate(
          { ...snapshot, ioPressurePct: value },
          binding.sourceSha,
          now
        )
      ).toThrow();
  });
});
