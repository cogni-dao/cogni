// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AkashTxAllocationRecord } from "@/ports/akash-tx.port";
import { DatabaseCellAppliedCustodySchema } from "@/shared/secrets/database-cell-binding.data";
import { DatabaseCellAppliedRegistrationFactsSchema } from "@/shared/secrets/database-cell-placement.data";
import { observeAppliedCellManaged } from "./database-cell-applied-managed.adapter";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const nodeId = "11111111-1111-4111-8111-111111111111";
const provider = `akash1${"a".repeat(38)}`;
const primaryImage = `sha256:${"1".repeat(64)}`;
const appImage = `sha256:${"2".repeat(64)}`;
const version = Buffer.alloc(32, 3).toString("base64");

function fixture() {
  const custody = DatabaseCellAppliedCustodySchema.parse({
    version: 1,
    nodeId,
    nodeSlug: "echo",
    environment: "production",
    manualProvenance: {
      kind: "manual-observed",
      postgresImageDigest: primaryImage,
      managedSdlSha256: "4".repeat(64),
      qualificationArtifactSha256: "5".repeat(64),
      qualifiedAt: "2026-10-15T06:00:00Z",
    },
    targetBuildSha: "6".repeat(40),
    canonicalEndpointHost: "echo-db.example.org",
    databaseName: "cogni_echo",
    appRole: "app_echo",
    serviceRole: "service_echo",
    budgetProfile: "dedicated-high-throughput-v1",
    budget: {
      kind: "preserved-role-bounds",
      roles: ["app_echo", "service_echo"].map((name) => ({
        name,
        connectionLimit: name === "app_echo" ? 4 : 8,
        statementTimeoutMs: 2000,
        lockTimeoutMs: 0,
        idleInTransactionTimeoutMs: 30000,
        tempFileLimitMiB: 128,
        workMemMiB: 8,
      })),
    },
    runtimePoolLimits: { replicaCount: 1, app: 3, service: 4, read: 2 },
    tlsCertificate: "-----BEGIN CERTIFICATE-----fixture",
    tls: { kind: "system" },
    app: {
      dsn: "postgresql://app_echo:fixture@echo-db.example.org:15432/cogni_echo?sslmode=verify-full",
      custody: { service: "echo", key: "DATABASE_URL" },
    },
    service: {
      dsn: "postgresql://service_echo:fixture@echo-db.example.org:15432/cogni_echo?sslmode=verify-full",
      custody: { service: "echo", key: "DATABASE_SERVICE_URL" },
    },
    migration: { kind: "app-database-url" },
  });
  const record = (
    cogniKey: string,
    receiptId: string,
    externalName: string,
    lastAppliedSdlHash: string
  ): AkashTxAllocationRecord => ({
    cogniKey,
    receiptId,
    externalName,
    lastAppliedSdlHash,
    providerAccount: provider,
    identity: { nodeId, compositeUid: cogniKey, compositeGeneration: 1 },
    workload: "echo",
    environment: "production",
    state: "allocated",
  });
  const primary = record(
    "primary",
    "22222222-2222-4222-8222-222222222222",
    "1001",
    "4".repeat(64)
  );
  const app = record(
    "app",
    "33333333-3333-4333-8333-333333333333",
    "1002",
    "7".repeat(64)
  );
  const packet =
    DatabaseCellAppliedRegistrationFactsSchema.shape.manualCutover.parse({
      packetSha256: "8".repeat(64),
      purpose: "production-primary",
      nodeId,
      nodeSlug: "echo",
      environment: "production",
      manualProvenance: custody.manualProvenance,
      appAllocationReceiptId: app.receiptId,
      primaryManifestVersion: version,
      primaryServiceName: "postgres",
      appCogniKey: app.cogniKey,
      appDseq: app.externalName,
      appDsnSha256: sha(custody.app.dsn),
      serviceDsnSha256: sha(custody.service.dsn),
      migrationConsumer: "app-database-url",
      appSdlHash: app.lastAppliedSdlHash,
      appManifestVersion: version,
      appImageDigest: appImage,
      appEgressIp: "192.0.2.9",
      appServiceName: "web",
      runtimePoolLimits: custody.runtimePoolLimits,
      expectedRuntimeApplications: [
        { role: "service_echo", applicationName: "fixture-service" },
      ],
      expectedRelations: ["public.fixture"],
      preservedRoleBounds: custody.budget.roles,
      allocationReceiptId: primary.receiptId,
      systemIdentifier: "1234567890",
      appSourceSha: custody.targetBuildSha,
      sourceFenceReceiptSha256: "9".repeat(64),
      restorationParityManifestSha256: "a".repeat(64),
      executionActor: { kind: "agent", id: nodeId },
      approvalAuthority: {
        kind: "conversation-user",
        label: "CEO",
        humanAppUserId: null,
        source: "direct-user-instruction",
        decisionRef: "fixture",
        capturedAt: "2026-10-15T06:00:00Z",
        delegationDigest: "b".repeat(64),
      },
      approvedAt: "2026-10-15T06:00:00Z",
    });
  const read = vi.fn(async ({ cogniKey }: { cogniKey: string }) =>
    cogniKey === "primary" ? primary : app
  );
  const readManagedDefinition = vi.fn(
    async ({ leaseId }: { leaseId: string }) => ({
      observedAt: new Date().toISOString(),
      leaseId,
      ownerAccount: "fixture-owner",
      providerAccount: provider,
      providerSdl:
        leaseId === "1001"
          ? `services:\n  postgres:\n    image: postgres:15@${primaryImage}\n`
          : `services:\n  web:\n    image: fixture/web@${appImage}\n    env: [DATABASE_URL=opaque-provider-token]\n`,
      providerSdlSha256: "c".repeat(64),
      consoleManifestVersion: version,
      chainManifestVersion: version,
      services: [
        {
          name: leaseId === "1001" ? "postgres" : "web",
          observedGeneration: 2,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
          availableReplicas: 1,
          total: 1,
          available: 1,
        },
      ],
    })
  );
  const status = vi.fn(async ({ leaseId }: { leaseId: string }) => ({
    provider: "akash" as const,
    leaseId,
    state: "active" as const,
    endpoints: ["tcp://provider.example.org:15432"],
  }));
  return {
    custody,
    primary,
    app,
    packet,
    read,
    readManagedDefinition,
    input: {
      reference: {
        cogniKey: "primary",
        nodeId,
        allocationEnvironment: "production",
      },
      custody,
      packet,
      ledger: { read },
      console: { readManagedDefinition, status },
      readMountedCustody: vi.fn(async () => custody),
    },
  };
}

describe("owned applied-cell managed observation", () => {
  it("binds current owned receipts/manifests while hashing mounted consumers rather than opaque provider env", async () => {
    const current = fixture();
    const facts = await observeAppliedCellManaged(current.input);
    expect(facts.provider.dseq).toBe("1001");
    expect(facts.effectiveApp.appDsnSha256).toBe(sha(current.custody.app.dsn));
    expect(facts.effectiveApp.appDsnSha256).not.toBe(
      sha("opaque-provider-token")
    );
    expect(facts.effectiveApp.providerManifest.imageDigest).toBe(appImage);
    expect(facts.effectiveApp.runtimePoolLimits).toEqual({
      replicaCount: 1,
      app: 3,
      service: 4,
      read: 2,
    });
    expect(current.input.readMountedCustody).toHaveBeenCalledOnce();
    expect(current.read.mock.calls.map(([arg]) => arg.cogniKey)).toEqual([
      "primary",
      "app",
    ]);
  });
  it("refuses packet consumer drift, foreign receipts, and mid-read mounted custody changes before provider calls", async () => {
    for (const mutation of [
      "packet-dsn",
      "foreign-app",
      "mounted-race",
    ] as const) {
      const current = fixture();
      if (mutation === "packet-dsn")
        current.packet.appDsnSha256 = "0".repeat(64);
      if (mutation === "foreign-app")
        current.read.mockImplementation(async ({ cogniKey }) =>
          cogniKey === "primary"
            ? current.primary
            : {
                ...current.app,
                identity: {
                  ...current.app.identity,
                  nodeId: "44444444-4444-4444-8444-444444444444",
                },
              }
        );
      if (mutation === "mounted-race")
        current.input.readMountedCustody.mockImplementation(async () => ({
          ...current.custody,
          targetBuildSha: "0".repeat(40),
        }));
      await expect(observeAppliedCellManaged(current.input)).rejects.toThrow();
      expect(current.readManagedDefinition).not.toHaveBeenCalled();
    }
  });
  it("refuses a provider manifest transition differing from the immutable packet", async () => {
    const current = fixture();
    const original = current.readManagedDefinition.getMockImplementation();
    if (!original) throw new Error("fixture implementation absent");
    current.readManagedDefinition.mockImplementation(async (arg) => ({
      ...(await original(arg)),
      chainManifestVersion: Buffer.alloc(32, 4).toString("base64"),
    }));
    await expect(observeAppliedCellManaged(current.input)).rejects.toThrow(
      /provider_identity/
    );
  });
});
