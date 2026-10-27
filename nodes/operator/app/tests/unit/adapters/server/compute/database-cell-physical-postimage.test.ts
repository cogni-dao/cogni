// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@tests/unit/adapters/server/compute/database-cell-physical-postimage`
 * Purpose: Falsify unreviewed physical-recovery configuration deltas using synthetic private preimages.
 * Scope: Pure adapter qualification; no DB, credentials, provider or runtime actions.
 * Invariants: Correctly rehashed bytes cannot authorize changed startup, env or containment.
 * Side-effects: none
 * Links: database-cell-physical-postimage.ts, subtask.5023
 * @internal
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalEvidenceJson } from "@/adapters/server/compute/database-cell-applied-artifacts";
import {
  PhysicalRecoveryArtifactSchema,
  qualifyPhysicalPostimages,
} from "@/adapters/server/compute/database-cell-physical-postimage";
import {
  AppliedDatabaseCellReceiptSchema,
  physicalSourceBindingSha256,
} from "@/shared/secrets/database-cell-placement.data";
import type { DatabaseCellAppliedCustody } from "@/types/database-cell";

function basePostimageFixture() {
  const now = new Date().toISOString();
  const sha = (value: string) => value.repeat(64);
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const NODE = "5f79c3ac-7fbe-4d0f-a599-e364fb203755";
  const sourceRecord = {
    cogniKey: "source",
    providerAccount: `akash1${"d".repeat(38)}`,
  };
  const targetRecord = { providerAccount: sourceRecord.providerAccount };
  const image = `postgres@sha256:${sha("1")}`;
  const original = {
    version: "2.0",
    services: {
      postgres: {
        image,
        command: ["bash"],
        args: ["/original-start.sh"],
        env: ["PGDATA=/var/lib/postgresql/data/pgdata"],
        params: {
          storage: {
            database: { mount: "/var/lib/postgresql/data", readOnly: false },
          },
        },
        expose: [{ port: 5432, as: 5432, global: true }],
      },
    },
    profiles: { resources: { cpu: 2, memory: 8, storage: 100 } },
  };
  const sourceHeld = structuredClone(original);
  sourceHeld.services.postgres.command = ["sleep"];
  sourceHeld.services.postgres.args = ["infinity"];
  sourceHeld.services.postgres.params.storage.database.readOnly = true;
  const cold = structuredClone(original);
  cold.services.postgres.command = ["sleep"];
  cold.services.postgres.args = ["infinity"];
  cold.services.postgres.env = ["PGDATA=/var/lib/postgresql/data/pgdata"];
  cold.profiles.resources = { cpu: 4, memory: 16, storage: 200 };
  const normal = { ...cold, services: original.services };
  const appOriginal = {
    services: {
      app: {
        image: `app@sha256:${sha("2")}`,
        command: ["node"],
        args: ["server.js"],
        env: [
          "DATABASE_URL=old-app",
          "DATABASE_SERVICE_URL=old-service",
          "KEEP=original",
        ],
      },
    },
  };
  const appHeld = structuredClone(appOriginal);
  appHeld.services.app.command = ["sleep"];
  appHeld.services.app.args = ["infinity"];
  appHeld.services.app.env = [
    "DATABASE_URL=new-app",
    "DATABASE_SERVICE_URL=new-service",
    "KEEP=original",
  ];
  const definitions = {
    sourceOriginal: JSON.stringify(original),
    sourceHeld: JSON.stringify(sourceHeld),
    targetCold: JSON.stringify(cold),
    targetNormal: JSON.stringify(normal),
    appOriginal: JSON.stringify(appOriginal),
    appHeld: JSON.stringify(appHeld),
  };
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const ledgerPreimages = {
    sourceOriginal: JSON.stringify(original, null, 2),
    targetCold: JSON.stringify(cold, null, 2),
    appOriginal: JSON.stringify(appOriginal, null, 2),
  };
  const ledgerHashes = {
    source: digest(ledgerPreimages.sourceOriginal),
    target: digest(ledgerPreimages.targetCold),
    app: digest(ledgerPreimages.appOriginal),
  };
  const startup = digest(
    JSON.stringify([
      original.services.postgres.command,
      original.services.postgres.args,
    ])
  );
  const evidence = {
    version: 1,
    observedAt: now,
    source: {
      cogniKey: sourceRecord.cogniKey,
      receiptId: id(1),
      dseq: "10001",
      providerAccount: sourceRecord.providerAccount,
      systemIdentifier: "1234567890",
      originalAppliedSdlHash: ledgerHashes.source,
      heldSdlHash: digest(definitions.sourceHeld),
      manifestVersion: Buffer.alloc(32, 1).toString("base64"),
      serviceName: "postgres",
      observedAt: now,
      postgresAbsent: true,
      mount: {
        path: "/var/lib/postgresql/data",
        device: "/dev/a",
        majorMinor: "8:1",
        readOnly: true,
      },
    },
    copy: {
      startedAt: now,
      completedAt: now,
      bytes: 100,
      files: 10,
      postgresMajor: 15,
      uid: 999,
      gid: 999,
      sourceManifestSha256: sha("1"),
      targetManifestSha256: sha("1"),
      sourceMetadataSha256: sha("2"),
      targetMetadataSha256: sha("2"),
      allTablespacesCovered: true,
      transportDrained: true,
      originalStartupSha256: startup,
      targetStartupSha256: startup,
    },
    target: {
      observedAt: now,
      dseq: "10002",
      providerAccount: targetRecord.providerAccount,
      originalAppliedSdlHash: ledgerHashes.target,
      preimageSdlHash: digest(definitions.targetCold),
      normalSdlHash: digest(definitions.targetNormal),
      manifestVersion: Buffer.alloc(32, 2).toString("base64"),
      volume: {
        path: "/var/lib/postgresql/data",
        device: "/dev/b",
        majorMinor: "8:2",
        totalBytes: 200000,
        usedBytes: 100000,
        availableBytes: 90000,
        totalInodes: 1000,
        availableInodes: 900,
      },
    },
    app: {
      originalAppliedSdlHash: ledgerHashes.app,
      preimageSdlHash: digest(definitions.appOriginal),
      heldSdlHash: digest(definitions.appHeld),
      manifestVersion: Buffer.alloc(32, 3).toString("base64"),
      observedAt: now,
      businessWritersAbsent: true,
    },
    reconciliation: {
      observedAt: now,
      kind: "incident-owner",
      approvalArtifactSha256: sha("f"),
      providerOperationsSettled: true,
      custodyVersionsSha256: sha("3"),
      independentCustodianWatching: true,
    },
    preservedBackup: {
      receiptSha256: sha("5"),
      archiveSha256: sha("6"),
      bytes: 1000,
    },
  };
  const custody: DatabaseCellAppliedCustody = {
    version: 1,
    nodeId: NODE,
    nodeSlug: "fixture",
    environment: "production",
    manualProvenance: {
      kind: "manual-observed",
      postgresImageDigest: `sha256:${sha("1")}`,
      managedSdlSha256: sha("a"),
      qualificationArtifactSha256: sha("b"),
      qualifiedAt: now,
    },
    targetBuildSha: "a".repeat(40),
    canonicalEndpointHost: "db.fixture.invalid",
    databaseName: "cogni_fixture",
    appRole: "app_fixture",
    serviceRole: "service_fixture",
    budgetProfile: "shared-default-v1",
    budget: { kind: "preserved-role-bounds", roles: [] },
    tlsCertificate: "fixture-certificate",
    tls: { kind: "system" },
    app: {
      dsn: "new-app",
      custody: { service: "fixture", key: "DATABASE_URL" },
    },
    service: {
      dsn: "new-service",
      custody: { service: "fixture", key: "DATABASE_SERVICE_URL" },
    },
    migration: { kind: "app-database-url" },
  };
  return {
    artifact: PhysicalRecoveryArtifactSchema.parse({
      evidence,
      definitions,
      ledgerPreimages: { targetCold: ledgerPreimages.targetCold },
    }),
    ledgerHashes,
    custody,
    primaryServiceName: "postgres",
    appServiceName: "app",
  };
}
function shaBytes(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function rehashPrivatePostimages(
  input: ReturnType<typeof basePostimageFixture>
) {
  const { definitions: d, evidence: e } = input.artifact;
  e.source.heldSdlHash = shaBytes(d.sourceHeld);
  e.target.preimageSdlHash = shaBytes(d.targetCold);
  e.target.normalSdlHash = shaBytes(d.targetNormal);
  e.app.preimageSdlHash = shaBytes(d.appOriginal);
  e.app.heldSdlHash = shaBytes(d.appHeld);
  const script = (value: string) => {
    const service = JSON.parse(value).services.postgres;
    return JSON.stringify([service.command ?? [], service.args ?? []]);
  };
  e.copy.originalStartupSha256 = shaBytes(script(d.sourceOriginal));
  e.copy.targetStartupSha256 = shaBytes(script(d.targetNormal));
}
function legacyPostimageFixture() {
  const input = basePostimageFixture(),
    d = input.artifact.definitions,
    e = input.artifact.evidence;
  const original = JSON.parse(d.sourceOriginal);
  original.services.postgres.command = ["/bin/sh", "-ec"];
  original.services.postgres.args = [
    "exec postgres -c fsync=on -c synchronous_commit=on -c full_page_writes=on",
  ];
  d.sourceOriginal = JSON.stringify(original);
  const held = structuredClone(original);
  held.services.postgres.command = ["sleep"];
  held.services.postgres.args = ["infinity"];
  held.services.postgres.params.storage.database.readOnly = true;
  d.sourceHeld = JSON.stringify(held);
  const guard = "# independently reviewed existing-cluster guard\n";
  const normal = JSON.parse(d.targetNormal);
  normal.services.postgres = structuredClone(original.services.postgres);
  normal.services.postgres.args = [guard + original.services.postgres.args[0]];
  d.targetNormal = JSON.stringify(normal);
  d.appHeld = d.appOriginal;
  input.ledgerHashes.source = "d".repeat(64);
  e.source.originalAppliedSdlHash = input.ledgerHashes.source;
  const at = e.observedAt,
    packet = "a".repeat(64),
    authority = {
      kind: "conversation-user",
      label: "CEO",
      humanAppUserId: null,
      source: "direct-user-instruction",
      decisionRef: "fixture:approved",
      capturedAt: at,
      delegationDigest: "f".repeat(64),
    };
  const binding = AppliedDatabaseCellReceiptSchema.parse({
    allocationEnvironment: "production",
    targetBuildSha: input.custody.targetBuildSha,
    registration: {
      kind: "audited-manual",
      executionActor: { kind: "agent", id: input.custody.nodeId },
      approvalAuthority: authority,
      readmissionReceiptId: "genuine-source-admission",
      manualCutoverPacketSha256: packet,
      sourceSystemIdentifier: "777777777",
      scheduledBackupReceiptSha256: packet,
      independentRecoveryReceiptSha256: packet,
      appAllocationReceiptId: "00000000-0000-4000-8000-000000000003",
      appSdlHash: input.ledgerHashes.app,
      appDsnSha256: shaBytes("old-app"),
      serviceDsnSha256: shaBytes("old-service"),
      migrationDsnSha256: shaBytes("old-app"),
      migrationConsumer: "app-database-url",
      tlsTrustKind: "system",
      registeredAt: at,
    },
    binding: {
      version: 1,
      phase: "applied",
      receiptId: e.source.receiptId,
      cogniKey: e.source.cogniKey,
      nodeId: input.custody.nodeId,
      nodeSlug: "fixture",
      environment: "production",
      provider: "akash",
      dseq: e.source.dseq,
      providerAccount: e.source.providerAccount,
      endpoint: {
        host: "source.fixture.invalid",
        port: 25432,
        tlsMode: "verify-full",
        tlsCertificateSha256: packet,
      },
      databaseName: "cogni_fixture",
      appRole: "app_fixture",
      serviceRole: "service_fixture",
      systemIdentifier: e.source.systemIdentifier,
      failureDomainId: `akash:${e.source.providerAccount}:${e.source.dseq}`,
      manualProvenance: input.custody.manualProvenance,
      budgetProfile: "shared-default-v1",
      appliedSdlHash: input.ledgerHashes.source,
      readyAt: at,
      cutover: {
        packetSha256: packet,
        actorId: "human:fixture",
        approvedAt: at,
      },
    },
  });
  const capture = {
    sourceCapturedAt: e.copy.startedAt,
    originalStoredSdl: JSON.stringify({ ...original, storedAliasDomain: true }),
    originalAppStoredSdl: d.appOriginal,
    originalProviderManifest: [
      { services: [{ name: "postgres", ...original.services.postgres }] },
    ],
    originalAppProviderManifest: [
      {
        services: [{ name: "app", ...JSON.parse(d.appOriginal).services.app }],
      },
    ],
    sourceBinding: binding,
    historicalCanonicalBytesRecovered: false as const,
  };
  input.artifact.nativeCapture = capture;
  input.artifact.startupGuard = guard;
  input.custody = {
    ...input.custody,
    physicalRecoverySource: {
      kind: "legacy-native-capture",
      incidentRef: "https://fixture.invalid/incidents/recovery",
      sourceReceiptId: e.source.receiptId,
      captureSha256: shaBytes(canonicalEvidenceJson(capture)),
      sourceBindingSha256: physicalSourceBindingSha256(binding),
      approvalArtifactSha256: authority.delegationDigest,
      startupGuardSha256: shaBytes(guard),
    },
  };
  rehashPrivatePostimages(input);
  e.copy.originalStartupSha256 = shaBytes(original.services.postgres.args[0]);
  e.copy.targetStartupSha256 = shaBytes(normal.services.postgres.args[0]);
  return input;
}

describe("authenticated legacy native custody", () => {
  it("accepts preserved unknown historical bytes and separately approved guard without fake SDK equality", () => {
    const input = legacyPostimageFixture();
    expect(shaBytes(input.artifact.definitions.sourceOriginal)).not.toBe(
      input.ledgerHashes.source
    );
    expect(() => qualifyPhysicalPostimages(input)).not.toThrow();
  });
  it("rejects coherently changed originals and target startup against the independently pinned capture", () => {
    const input = legacyPostimageFixture();
    const capture = input.artifact.nativeCapture;
    if (!capture) throw new Error("capture missing");
    for (const name of ["sourceOriginal", "targetNormal"] as const) {
      const changed = JSON.parse(input.artifact.definitions[name]);
      changed.services.postgres.args = ["exec postgres -c fsync=off"];
      input.artifact.definitions[name] = JSON.stringify(changed);
    }
    capture.originalProviderManifest[0].services[0].args = [
      "exec postgres -c fsync=off",
    ];
    rehashPrivatePostimages(input);
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_custody"
    );
  });
  it("rejects replacement guard or a secretly retargeted business consumer", () => {
    const input = legacyPostimageFixture();
    input.artifact.startupGuard = "# bypass existing cluster checks\n";
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_custody"
    );
    const moved = legacyPostimageFixture();
    const capture = moved.artifact.nativeCapture;
    if (!capture) throw new Error("capture missing");
    capture.originalAppProviderManifest[0].services[0].env = [
      "DATABASE_URL=new-app",
      "DATABASE_SERVICE_URL=old-service",
    ];
    expect(() => qualifyPhysicalPostimages(moved)).toThrow(
      "independent_custody"
    );
  });
});

describe("fixed legacy postimage boundaries", () => {
  it("refuses coherently rehashed source hold, target env and app changes", () => {
    for (const field of ["sourceHeld", "targetNormal", "appHeld"] as const) {
      const input = legacyPostimageFixture();
      const value = JSON.parse(input.artifact.definitions[field]);
      const name = field === "appHeld" ? "app" : "postgres";
      value.services[name].env.push("UNREVIEWED=changed");
      input.artifact.definitions[field] = JSON.stringify(value);
      rehashPrivatePostimages(input);
      expect(() => qualifyPhysicalPostimages(input)).toThrow();
    }
  });
  it("keeps the cold recipe independently ledger anchored", () => {
    const input = legacyPostimageFixture();
    for (const field of ["targetCold", "targetNormal"] as const) {
      const value = JSON.parse(input.artifact.definitions[field]);
      value.profiles.resources.storage = 50;
      input.artifact.definitions[field] = JSON.stringify(value);
    }
    rehashPrivatePostimages(input);
    expect(() => qualifyPhysicalPostimages(input)).toThrow("unreviewed_delta");
    input.artifact.ledgerPreimages.targetCold =
      input.artifact.definitions.targetCold;
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_ledger_anchor"
    );
  });
  it("rejects missing independent capture or altered historical source binding", () => {
    const input = legacyPostimageFixture();
    delete input.artifact.nativeCapture;
    expect(() => qualifyPhysicalPostimages(input)).toThrow(
      "independent_custody"
    );
    const changed = legacyPostimageFixture();
    const capture = changed.artifact.nativeCapture;
    if (!capture) throw new Error("capture absent");
    capture.sourceBinding.registration.readmissionReceiptId =
      "invented-source-admission";
    expect(() => qualifyPhysicalPostimages(changed)).toThrow(
      "independent_custody"
    );
  });
});
