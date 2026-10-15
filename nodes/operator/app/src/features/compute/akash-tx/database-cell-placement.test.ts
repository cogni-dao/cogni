// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { repoSpecSchema } from "@cogni/repo-spec";
import { buildTestRepoSpec } from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";
import {
  DatabaseCellAppliedRegistrationReferenceSchema,
  DatabaseCellBindingReferenceSchema,
} from "@/contracts/database-cell-binding.v1.contract";
import { DatabaseCellBinder } from "@/features/compute/akash-tx/database-cell-binding";
import type {
  AkashTxAllocationRecord,
  DatabaseCellAppliedRegistrationFacts,
  DatabaseCellNativeProof,
} from "@/ports";
import { composeDatabaseCellDsn } from "@/shared/secrets/database-cell-binding.data";
import {
  type AppliedDatabaseCellReceipt,
  AppliedDatabaseCellReceiptSchema,
  assessDatabaseCellBackupRuntime,
  DatabaseCellAllocationMetadataSchema,
  DatabaseCellAppliedEvidenceBundleSchema,
} from "@/shared/secrets/database-cell-placement.data";
import {
  materializeDatabaseCellKits,
  planDatabaseCellKits,
} from "../../../../../../../scripts/lib/materialize-database-cell-kits";
import { projectDatabaseCellPlacement } from "../../../../../../../scripts/lib/materialize-database-cell-placement";

const nodeId = "11111111-1111-4111-8111-111111111111";
const sourceSha = "a".repeat(40);
const appSha = "b".repeat(40);
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
const kit = materializeDatabaseCellKits({
  plans: planDatabaseCellKits({
    operatorSourceSha: sourceSha,
    environment: "production",
    expectedSourceHost: "10.0.0.1",
    nativeSource: {
      systemIdentifier: "12",
      databases: ["cogni_alpha"],
      roles: ["app_alpha", "service_alpha"],
    },
    slots: [
      {
        nodeId,
        nodeSlug: "alpha",
        environment: "production",
        physicalEnvironment: "production",
        sourceSha: appSha,
        budgetProfile: "dedicated-high-throughput-v1",
        budget,
        appDsn: "postgresql://app_alpha:x@10.0.0.1:5432/cogni_alpha",
        serviceDsn: "postgresql://service_alpha:x@10.0.0.1:5432/cogni_alpha",
      },
    ],
  }),
  existingKits: [],
  existingPublished: [],
  existingAuthorities: [],
}).nodeKits[0];
if (!kit) throw new Error("fixture kit absent");
const scopedKit = kit;

function fixture(
  options: {
    canonicalEndpointHost?: string;
    endpointIdentity?: DatabaseCellNativeProof["endpointIdentity"];
    appliedFacts?: DatabaseCellAppliedRegistrationFacts;
    conflict?: boolean;
  } = {}
) {
  let saved: readonly AppliedDatabaseCellReceipt[] = [];
  let nativeReads = 0;
  const appliedFacts = options.appliedFacts;
  let writes = 0;
  let endpoints = ["tcp://provider.example.org:15432"];
  let restored = false;
  const record: AkashTxAllocationRecord = {
    receiptId: "22222222-2222-4222-8222-222222222222",
    cogniKey: "fixture-cell",
    identity: { nodeId, compositeUid: "fixture", compositeGeneration: 1 },
    workload: "alpha-database-cell",
    environment: "production",
    state: "allocated",
    externalName: "123",
    providerAccount: `akash1${"a".repeat(38)}`,
    lastAppliedSdlHash: "d".repeat(64),
  };
  const ref = {
    cogniKey: record.cogniKey,
    nodeId,
    allocationEnvironment: "production",
  };
  const binder = new DatabaseCellBinder({
    ledger: { read: async () => record, listAllocated: async () => [record] },
    actuator: {
      observe: async () => ({
        found: true,
        resource: {
          externalName: "123",
          state: "active",
          endpoints,
          providerAccount: `akash1${"a".repeat(38)}`,
        },
      }),
    },
    store: {
      read: async () => saved,
      save: async (_record, receipts, expected) => {
        if (options.conflict) throw new Error("allocation changed during CAS");
        expect(saved).toEqual(expected);
        saved = receipts;
        writes += 1;
      },
    },
    kit: async () => ({
      ...scopedKit,
      ...(options.canonicalEndpointHost
        ? { canonicalEndpointHost: options.canonicalEndpointHost }
        : {}),
    }),
    buildSha: sourceSha,
    ...(appliedFacts
      ? {
          observeApplied: async () => appliedFacts,
          appliedCustody: async () => appliedCustody(),
        }
      : {}),
    observeNative: async () => {
      nativeReads += 1;
      return scopedKit.logicalDatabases.map(
        (lane): DatabaseCellNativeProof => ({
          lane,
          ...(options.endpointIdentity
            ? { endpointIdentity: options.endpointIdentity }
            : {}),
          observation: {
            database: lane.databaseName,
            role: lane.probeRole,
            systemIdentifier: "1234567890123456789",
            runtimeRolesNoLogin: true,
            activeRuntimeSessions: 0,
            systemTenantExists: restored,
            backupQualified: restored,
          },
          incident: { incidentId: "native-cell-initial", state: "contained" },
        })
      );
    },
  });
  return {
    nativeReads: () => nativeReads,
    ref,
    binder,
    writes: () => writes,
    restore: () => {
      restored = true;
    },
    wrongHost: () => {
      endpoints = ["tcp://10.0.0.9:15432"];
    },
  };
}

describe("same-receipt production cell placement", () => {
  it("accepts references only, never caller endpoint, native identity or secrets", () => {
    const { ref } = fixture();
    expect(
      DatabaseCellBindingReferenceSchema.safeParse({
        ...ref,
        endpoint: "tcp://forged.example.org:5432",
      }).success
    ).toBe(false);
    expect(
      DatabaseCellBindingReferenceSchema.safeParse({
        ...ref,
        systemIdentifier: "forged",
      }).success
    ).toBe(false);
    expect(
      DatabaseCellBindingReferenceSchema.safeParse({
        ...ref,
        rootPassword: "caller",
      }).success
    ).toBe(false);
  });
  it("seals native identity idempotently while readiness keeps every public DSN unchanged", async () => {
    const { ref, binder, writes } = fixture();
    const first = await binder.seal(ref);
    expect(first[0]?.allocationEnvironment).toBe("production");
    expect(first[0]?.targetBuildSha).toBe(appSha);
    expect(first[0]?.initialIncidentId).toBe("native-cell-initial");
    expect(await binder.seal(ref)).toEqual(first);
    expect(writes()).toBe(1);
    const projection = projectDatabaseCellPlacement({
      receipt: first[0],
      kit: scopedKit,
      backupEncryptionKey: "e".repeat(64),
    });
    expect(projection.publicValues).toBeNull();
    expect(projection.backup?.dsn).toContain("backup_alpha:");
    expect(projection.admin?.dsn).toContain("database_reliability_actuator:");
    expect(projection.readmit?.dsn).toContain(
      "database_reliability_readmitter:"
    );
  });
  it("requires restored native containment and one immutable reviewed packet before production DSN rotation", async () => {
    const current = fixture();
    const input = {
      ...current.ref,
      actorId: "human:fixture",
      packetSha256: "f".repeat(64),
    };
    await expect(current.binder.cutover(input)).rejects.toThrow("restored");
    current.restore();
    const applied = await current.binder.cutover(input);
    const projection = projectDatabaseCellPlacement({
      receipt: applied[0],
      kit: scopedKit,
      backupEncryptionKey: "e".repeat(64),
    });
    expect(projection.publicValues?.DATABASE_URL).toContain(
      "provider.example.org:15432/cogni_alpha?sslmode=verify-full"
    );
    expect(projection.publicValues?.DATABASE_MIGRATION_URL).toContain(
      "migration_alpha:"
    );
    expect(projection.publicValues?.DATABASE_SSL_CA_CERT).toBe(
      scopedKit.tlsCaCertificate
    );
    expect(await current.binder.cutover(input)).toEqual(applied);
    await expect(
      current.binder.cutover({ ...input, packetSha256: "c".repeat(64) })
    ).rejects.toThrow("rebound");
    await expect(
      current.binder.cutover({ ...input, allocationEnvironment: "candidate-a" })
    ).rejects.toThrow("production");
  });
  it("preserves applied physical custody across unrelated operator artifacts and refuses mismatches", async () => {
    const current = fixture();
    current.restore();
    const receipts = await current.binder.cutover({
      ...current.ref,
      actorId: "human:fixture",
      packetSha256: "f".repeat(64),
    });
    const repoRoot = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const script = `set -euo pipefail
REPO_ROOT="$1"
IFS= read -r CELL_RECEIPT
IFS= read -r CELL_KIT
IFS= read -r CELL_BACKUP_KEY
TARGET_NODE=controller RELIABILITY_CONTROLLER=controller DEPLOY_ENVIRONMENT=production DOMAIN=fixture.example.org
APP_SOURCE_DIR="$REPO_ROOT" CATALOG_DIR=/unused-catalog
NODE_TARGETS=(alpha)
yq() { :; }
git() { printf '%s' cccccccccccccccccccccccccccccccccccccccc; }
prefetch_path() { :; }
node_id_for_target() { printf '%s' 11111111-1111-4111-8111-111111111111; }
bao_get_field() {
  case "$2" in
    DATABASE_CELL_PLACEMENT_RECEIPT_JSON) printf '%s' "$CELL_RECEIPT" ;;
    DATABASE_CELL_BOOTSTRAP_KIT_JSON) printf '%s' "$CELL_KIT" ;;
    DATABASE_CELL_BACKUP_ENCRYPTION_KEY) printf '%s' "$CELL_BACKUP_KEY" ;;
  esac
}
fail() { printf '%s\\n' "$*" >&2; exit 1; }
seed_kv() { fail "unexpected secret write"; }
remote() { fail "unexpected source native census"; }
curl() { fail "unexpected source version census"; }
source "$REPO_ROOT/scripts/ci/lib/materialize-database-cell-kits.sh"
materialize_database_cell_kits`;
    const input = (value: unknown) =>
      [
        JSON.stringify(receipts[0]),
        JSON.stringify(value),
        "e".repeat(64),
        "",
      ].join("\n");
    expect(
      execFileSync("bash", ["-c", script, "fixture", repoRoot], {
        cwd: repoRoot,
        input: input(scopedKit),
        encoding: "utf8",
      })
    ).toBe("");
    expect(() =>
      execFileSync("bash", ["-c", script, "fixture", repoRoot], {
        cwd: repoRoot,
        input: input({ ...scopedKit, sourceSha: "d".repeat(40) }),
        encoding: "utf8",
        stdio: "pipe",
      })
    ).toThrow();
  });
  it("rejects forged ownership/IP endpoint before receipt persistence", async () => {
    const current = fixture();
    await expect(
      current.binder.seal({
        ...current.ref,
        nodeId: "33333333-3333-4333-8333-333333333333",
      })
    ).rejects.toThrow("reference");
    current.wrongHost();
    await expect(current.binder.seal(current.ref)).rejects.toThrow("DNS");
    expect(current.writes()).toBe(0);
  });
});

describe("durable cell allocation custody", () => {
  it("accepts legacy empty metadata and explicit retention before native sealing", () => {
    expect(DatabaseCellAllocationMetadataSchema.parse([])).toMatchObject({
      bindings: [],
      retentionPolicy: undefined,
    });
    expect(
      DatabaseCellAllocationMetadataSchema.parse({
        version: 1,
        retentionPolicy: "retain",
        bindings: [],
      })
    ).toEqual({ version: 1, retentionPolicy: "retain", bindings: [] });
    expect(
      DatabaseCellAllocationMetadataSchema.safeParse({
        version: 1,
        retentionPolicy: "delete",
        bindings: [],
      }).success
    ).toBe(false);
  });
  it("retains a legacy verified cell without rewriting or weakening its binding proof", async () => {
    const { binder, ref, restore } = fixture();
    restore();
    const sealed = await binder.seal(ref);
    expect(DatabaseCellAllocationMetadataSchema.parse(sealed)).toMatchObject({
      retentionPolicy: "retain",
      bindings: sealed,
    });
  });
});

describe("declared Akash cell materialization", () => {
  it("validates dedicated placement while preserving undeclared shared nodes", () => {
    const checkPlacement = (production: unknown) =>
      repoSpecSchema.safeParse({
        ...buildTestRepoSpec(),
        state: {
          database: {
            environments: {
              "candidate-a": {
                tier: "shared",
                budget_profile: "shared-default-v1",
              },
              preview: { tier: "shared", budget_profile: "shared-default-v1" },
              production,
            },
          },
        },
      });
    expect(
      checkPlacement({
        tier: "dedicated",
        budget_profile: "dedicated-high-throughput-v1",
        placement: "akash-cell",
      }).success
    ).toBe(true);
    expect(
      checkPlacement({
        tier: "shared",
        budget_profile: "shared-default-v1",
        placement: "akash-cell",
      }).success
    ).toBe(false);
    expect(
      checkPlacement({
        tier: "shared",
        budget_profile: "shared-default-v1",
      }).success
    ).toBe(true);
  });
  it("refuses missing, unapproved and mismatched bindings before composition; repeats applied values exactly", async () => {
    const current = fixture();
    const ready = await current.binder.seal(current.ref);
    current.restore();
    const applied = await current.binder.cutover({
      ...current.ref,
      actorId: "human:fixture",
      packetSha256: "f".repeat(64),
    });
    const repoRoot = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const script = `set -euo pipefail
REPO_ROOT="$1"
IFS= read -r CELL_RECEIPT
IFS= read -r CELL_KIT
IFS= read -r CELL_BACKUP_KEY
IFS= read -r REQUIRED
TARGET_NODE=alpha DEPLOY_ENVIRONMENT=production SECRETS_CONTROL_ENV=production CATALOG_DIR=/unused-catalog
prefetch_path() { :; }
node_id_for_target() { printf '%s' 11111111-1111-4111-8111-111111111111; }
yq() { printf '%s' "$REQUIRED"; }
bao_get_field() {
  case "$2" in
    DATABASE_CELL_PLACEMENT_RECEIPT_JSON) printf '%s' "$CELL_RECEIPT" ;;
    DATABASE_CELL_BOOTSTRAP_KIT_JSON) printf '%s' "$CELL_KIT" ;;
    DATABASE_CELL_BACKUP_ENCRYPTION_KEY) printf '%s' "$CELL_BACKUP_KEY" ;;
  esac
}
fail() { printf '%s\\n' "$*" >&2; exit 1; }
seed_kv() { fail "unexpected write"; }
source "$REPO_ROOT/scripts/ci/lib/materialize-database-cell-placement.sh"
load_database_cell_placement
if [[ -n "$CELL_PLACEMENT_JSON" ]]; then
  for key in DATABASE_URL DATABASE_SERVICE_URL DATABASE_MIGRATION_URL DATABASE_SSL_CA_CERT; do
    cell_placement_composed_value alpha "$key"
    printf '\\n'
  done
  if cell_placement_composed_value alpha DOLTGRES_URL; then fail "cell stole Doltgres"; fi
fi`;
    const run = (
      receipt: unknown,
      selectedKit: unknown = scopedKit,
      required = "akash-cell"
    ) =>
      execFileSync("bash", ["-c", script, "fixture", repoRoot], {
        cwd: repoRoot,
        input: [
          receipt ? JSON.stringify(receipt) : "",
          JSON.stringify(selectedKit),
          "e".repeat(64),
          required,
          "",
        ].join("\n"),
        encoding: "utf8",
        stdio: "pipe",
      });
    expect(() => run(null)).toThrow();
    expect(() => run(ready[0])).toThrow();
    expect(() =>
      run(applied[0], {
        ...scopedKit,
        nodeId: "33333333-3333-4333-8333-333333333333",
      })
    ).toThrow();
    expect(run(null, scopedKit, "")).toBe("");
    const first = run(applied[0]);
    expect(run(applied[0])).toBe(first);
    expect(first).toContain(
      "provider.example.org:15432/cogni_alpha?sslmode=verify-full"
    );
    expect(first).toContain("migration_alpha:");
    expect(first).not.toContain("10.0.0.1");
  });
});

describe("owned canonical DNS cell endpoint", () => {
  it("requires fresh measured provider/DNS/TLS/native identity facts before sealing an alias", async () => {
    const canonicalEndpointHost = "poly-db.fixture.example.org";
    const missing = fixture({ canonicalEndpointHost });
    await expect(missing.binder.seal(missing.ref)).rejects.toThrow(
      "not proven"
    );
    const endpointIdentity = {
      observedAt: new Date().toISOString(),
      provider: {
        host: "provider.example.org",
        port: 15432,
        addresses: ["192.0.2.10"],
      },
      canonical: {
        host: canonicalEndpointHost,
        port: 15432,
        addresses: ["192.0.2.10"],
      },
      peerCertificateDerSha256: createHash("sha256")
        .update(new X509Certificate(scopedKit.tlsCertificate).raw)
        .digest("hex"),
      systemIdentifier: "1234567890123456789",
    };
    const valid = fixture({ canonicalEndpointHost, endpointIdentity });
    const sealed = await valid.binder.seal(valid.ref);
    expect(sealed[0]?.binding.endpoint.host).toBe(canonicalEndpointHost);
    expect(sealed[0]?.binding.endpoint.port).toBe(15432);
    expect(sealed[0]?.binding.systemIdentifier).toBe(
      endpointIdentity.systemIdentifier
    );
    for (const mismatch of [
      {
        ...endpointIdentity,
        canonical: { ...endpointIdentity.canonical, addresses: ["192.0.2.11"] },
      },
      { ...endpointIdentity, peerCertificateDerSha256: "0".repeat(64) },
      { ...endpointIdentity, systemIdentifier: "999" },
      { ...endpointIdentity, observedAt: "2000-01-01T00:00:00Z" },
    ]) {
      const invalid = fixture({
        canonicalEndpointHost,
        endpointIdentity: mismatch,
      });
      await expect(invalid.binder.seal(invalid.ref)).rejects.toThrow(
        "not proven"
      );
      expect(invalid.writes()).toBe(0);
    }
    expect(
      DatabaseCellBindingReferenceSchema.safeParse({
        ...valid.ref,
        canonicalEndpointHost,
      }).success
    ).toBe(false);
  });
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
function preservedRoleBounds() {
  return [
    {
      name: "app_alpha",
      connectionLimit: 4,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 0,
      idleInTransactionTimeoutMs: 30000,
      tempFileLimitMiB: 256,
      workMemMiB: 8,
    },
    {
      name: "service_alpha",
      connectionLimit: 8,
      statementTimeoutMs: 2000,
      lockTimeoutMs: 0,
      idleInTransactionTimeoutMs: 30000,
      tempFileLimitMiB: 128,
      workMemMiB: 8,
    },
  ];
}
function appliedCustody() {
  const lane = scopedKit.logicalDatabases[0];
  if (!lane) throw new Error("fixture lane absent");
  const endpoint = { host: "poly-db.fixture.example.org", port: 15432 };
  return {
    version: 1 as const,
    nodeId,
    nodeSlug: "alpha",
    environment: "production" as const,
    sourceSha,
    targetBuildSha: appSha,
    canonicalEndpointHost: endpoint.host,
    databaseName: lane.databaseName,
    appRole: lane.appRole,
    serviceRole: lane.serviceRole,
    budgetProfile: lane.budgetProfile,
    budget: {
      kind: "preserved-role-bounds" as const,
      roles: preservedRoleBounds(),
    },
    tlsCertificate: scopedKit.tlsCertificate,
    tls: { kind: "system" as const },
    app: {
      dsn: composeDatabaseCellDsn(
        endpoint,
        lane.databaseName,
        lane.appRole,
        lane.appPassword
      ),
      custody: { service: "alpha", key: "DATABASE_URL" },
    },
    service: {
      dsn: composeDatabaseCellDsn(
        endpoint,
        lane.databaseName,
        lane.serviceRole,
        lane.servicePassword
      ),
      custody: { service: "alpha", key: "DATABASE_SERVICE_URL" },
    },
    migration: { kind: "app-database-url" as const },
  };
}

function registrationFacts(): Mutable<DatabaseCellAppliedRegistrationFacts> {
  const sha = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const lane = scopedKit.logicalDatabases[0];
  if (!lane) throw new Error("fixture lane missing");
  const ago = (seconds: number) =>
    new Date(Date.now() - seconds * 1000).toISOString();
  const canonical = { host: "poly-db.fixture.example.org", port: 15432 };
  const url = (role: string, password: string) =>
    composeDatabaseCellDsn(canonical, lane.databaseName, role, password);
  const relationNames = Array.from(
    { length: 68 },
    (_, index) => `public.table_${index}`
  );
  const fingerprint = {
    fullSchemaFingerprintSha256: "1".repeat(64),
    fullDataFingerprintSha256: "2".repeat(64),
    sequenceStateFingerprintSha256: "3".repeat(64),
    relations: relationNames,
    rowCount: "20409387",
  };
  return {
    observedAt: ago(0),
    backupRuntime: {
      observedAt: ago(0),
      timerActiveState: "active",
      nextRunAt: new Date(Date.now() + 900000).toISOString(),
      intervalSeconds: 900,
      jitterSeconds: 61,
      installedFullTimeoutSeconds: 3700,
      latestAttempt: { startedAt: ago(10), completedAt: ago(8), exitCode: 0 },
      latestCompletedBackup: {
        archiveSha256: "0".repeat(64),
        archiveBytes: 2846000000,
        snapshotStartedAt: ago(10),
        completedAt: ago(8),
        snapshotAgeSeconds: 10,
      },
    },
    provider: {
      dseq: "123",
      providerAccount: `akash1${"a".repeat(38)}`,
      appliedSdlHash: "d".repeat(64),
    },
    native: {
      databaseName: lane.databaseName,
      systemIdentifier: "1234567890123456789",
      appRole: lane.appRole,
      serviceRole: lane.serviceRole,
      runtimeRoles: preservedRoleBounds().map((role) => ({
        ...role,
        canLogin: true,
        roleReadOnly: false,
      })),
      activeRuntimeSessions: 3,
      serverVersionNum: 150018,
      tlsTrustKind: "system",
      endpointIdentity: {
        observedAt: ago(0),
        provider: {
          host: "provider.example.org",
          port: 15432,
          addresses: ["192.0.2.10"],
        },
        canonical: { ...canonical, addresses: ["192.0.2.10"] },
        peerCertificateDerSha256: shaBuffer(
          new X509Certificate(scopedKit.tlsCertificate).raw
        ),
        systemIdentifier: "1234567890123456789",
      },
    },
    effectiveApp: {
      allocationReceiptId: "88888888-8888-4888-8888-888888888888",
      deployedSourceSha: appSha,
      appliedSdlHash: "c".repeat(64),
      nodeId,
      environment: "production",
      appDsnSha256: sha(url(lane.appRole, lane.appPassword)),
      serviceDsnSha256: sha(url(lane.serviceRole, lane.servicePassword)),
      migrationDsnSha256: sha(url(lane.appRole, lane.appPassword)),
      tlsTrustKind: "system",
      migrationConsumer: "app-database-url",
      readinessReceiptSha256: "4".repeat(64),
      regions: [
        { region: "eu", status: 200, buildSha: appSha, observedAt: ago(0) },
        { region: "us", status: 200, buildSha: appSha, observedAt: ago(0) },
      ],
    },
    manualCutover: {
      packetSha256: "f".repeat(64),
      purpose: "production-primary",
      nodeId,
      nodeSlug: "alpha",
      environment: "production",
      cellSourceSha: sourceSha,
      appAllocationReceiptId: "88888888-8888-4888-8888-888888888888",
      appSdlHash: "c".repeat(64),
      expectedRelations: relationNames,
      preservedRoleBounds: preservedRoleBounds(),
      allocationReceiptId: "22222222-2222-4222-8222-222222222222",
      systemIdentifier: "1234567890123456789",
      appSourceSha: appSha,
      sourceFenceReceiptSha256: "5".repeat(64),
      restorationParityManifestSha256: "6".repeat(64),
      executionActor: {
        kind: "agent",
        id: "2c4b7be4-173f-49bc-97e6-043736c0dbd1",
      },
      approvalAuthority: {
        kind: "conversation-user",
        label: "CEO",
        humanAppUserId: null,
        source: "direct-user-instruction",
        decisionRef: "conductor://fixture/direct-user-delegation",
        capturedAt: ago(6),
        delegationDigest: "d".repeat(64),
      },
      approvedAt: ago(5),
    },
    readmission: {
      receiptId: "readmission-fixture",
      packetSha256: "f".repeat(64),
      allocationReceiptId: "22222222-2222-4222-8222-222222222222",
      systemIdentifier: "1234567890123456789",
      admittedAt: ago(4),
      executionActor: {
        kind: "agent",
        id: "2c4b7be4-173f-49bc-97e6-043736c0dbd1",
      },
      approvalAuthority: {
        kind: "conversation-user",
        label: "CEO",
        humanAppUserId: null,
        source: "direct-user-instruction",
        decisionRef: "conductor://fixture/direct-user-delegation",
        capturedAt: ago(6),
        delegationDigest: "d".repeat(64),
      },
    },
    scheduledBackup: {
      receiptSha256: "7".repeat(64),
      databaseName: lane.databaseName,
      systemIdentifier: "1234567890123456789",
      archiveSha256: "8".repeat(64),
      archiveBytes: 2845520022,
      snapshotStartedAt: ago(20),
      completedAt: ago(18),
      verifiedArchiveReceiptSha256: "9".repeat(64),
      schedulerUnitSha256: "a".repeat(64),
      executorFailureDomainId: "independent-backup-host",
      ...fingerprint,
    },
    independentRecovery: {
      receiptSha256: "b".repeat(64),
      archiveSha256: "8".repeat(64),
      restoredSystemIdentifier: "999999999999999999",
      providerAccount: `akash1${"b".repeat(38)}`,
      dseq: "456",
      recoveryFailureDomainId: `akash:akash1${"b".repeat(38)}:456`,
      completedAt: ago(15),
      ...fingerprint,
    },
  };
}
function shaBuffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("audited already-applied registration", () => {
  const request = {
    cogniKey: "fixture-cell",
    nodeId,
    allocationEnvironment: "production",
    manualCutoverPacketSha256: "f".repeat(64),
    readmissionReceiptId: "readmission-fixture",
  };
  it("admits reference-only input and refuses caller observations or approval flags", () => {
    expect(
      DatabaseCellAppliedRegistrationReferenceSchema.safeParse(request).success
    ).toBe(true);
    for (const injection of [
      { approved: true },
      { systemIdentifier: "123" },
      { backupPassed: true },
      { actorId: "human:forged" },
      { endpoint: "forged.invalid" },
      { rootPassword: "secret" },
    ])
      expect(
        DatabaseCellAppliedRegistrationReferenceSchema.safeParse({
          ...request,
          ...injection,
        }).success
      ).toBe(false);
  });
  it("fails closed without a distinct read-only evidence producer", async () => {
    const current = fixture();
    await expect(current.binder.registerApplied(request)).rejects.toMatchObject(
      { code: "ledger_unavailable" }
    );
    expect(current.nativeReads()).toBe(0);
    expect(current.writes()).toBe(0);
  });
  it("registers current admitted sessions using genuine receipts, preserves projection and repeats without writes", async () => {
    const facts = registrationFacts();
    const current = fixture({
      canonicalEndpointHost: "poly-db.fixture.example.org",
      appliedFacts: facts,
    });
    const receipts = await current.binder.registerApplied(request);
    expect(receipts[0]?.binding.phase).toBe("applied");
    expect(receipts[0]?.initialIncidentId).toBeUndefined();
    expect(receipts[0]?.binding.cutover?.actorId).toBe(
      "agent:2c4b7be4-173f-49bc-97e6-043736c0dbd1"
    );
    expect(
      receipts[0]?.registration?.approvalAuthority.humanAppUserId
    ).toBeNull();
    expect(receipts[0]?.binding.migrationRole).toBeUndefined();
    expect(
      AppliedDatabaseCellReceiptSchema.safeParse({
        ...receipts[0],
        initialIncidentId: "invented-native-history",
      }).success
    ).toBe(false);
    expect(receipts[0]?.registration?.readmissionReceiptId).toBe(
      request.readmissionReceiptId
    );
    expect(await current.binder.registerApplied(request)).toEqual(receipts);
    expect(current.writes()).toBe(1);
    expect(current.nativeReads()).toBe(0);
    expect(facts.backupRuntime.latestCompletedBackup.archiveSha256).not.toBe(
      facts.scheduledBackup.archiveSha256
    );
    expect(assessDatabaseCellBackupRuntime(facts.backupRuntime)).toMatchObject({
      snapshotAgeSeconds: 10,
      conditionalNominalWindowSeconds: 4661,
    });
    await expect(current.binder.seal(request)).rejects.toThrow(
      "cannot enter prestage"
    );
    expect(current.nativeReads()).toBe(0);
    const projected = projectDatabaseCellPlacement({
      receipt: receipts[0],
      custody: appliedCustody(),
      requireApplied: true,
    });
    expect(
      shaBuffer(Buffer.from(projected.publicValues?.DATABASE_URL ?? ""))
    ).toBe(facts.effectiveApp.appDsnSha256);
    expect(
      shaBuffer(
        Buffer.from(projected.publicValues?.DATABASE_MIGRATION_URL ?? "")
      )
    ).toBe(facts.effectiveApp.migrationDsnSha256);
    expect(projected.publicValues).not.toHaveProperty("DATABASE_SSL_CA_CERT");
    expect(projected.probe).toBeNull();
    expect(projected.admin).toBeNull();
    expect(projected.readmit).toBeNull();
    expect(projected.backup).toBeNull();
    expect(() =>
      projectDatabaseCellPlacement({
        receipt: receipts[0],
        custody: {
          ...appliedCustody(),
          app: {
            ...appliedCustody().app,
            dsn: appliedCustody().app.dsn.replace(":15432", ":15433"),
          },
        },
      })
    ).toThrow();
    expect(
      DatabaseCellAllocationMetadataSchema.parse({
        version: 1,
        retentionPolicy: "retain",
        bindings: receipts,
      }).retentionPolicy
    ).toBe("retain");
  });
  it("compares authenticated complete relation manifests without node-specific table-count policy", async () => {
    const facts = registrationFacts();
    const relations = ["public.positions", "drizzle.__drizzle_migrations"];
    facts.manualCutover.expectedRelations = relations;
    facts.scheduledBackup.relations = relations;
    facts.independentRecovery.relations = relations;
    const current = fixture({ appliedFacts: facts });
    const receipts = await current.binder.registerApplied(request);
    expect(receipts[0]?.binding.phase).toBe("applied");
    expect(current.writes()).toBe(1);
  });
  it("refuses wrong managed allocation, current DSNs, app SHA, partial recovery, schema drift and same-provider recovery", async () => {
    const invalidCases = [
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.backupRuntime.timerActiveState = "inactive";
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.backupRuntime.latestAttempt.exitCode = 1;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.backupRuntime.latestCompletedBackup.snapshotAgeSeconds = 200;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        const role = f.native.runtimeRoles[0];
        if (role) role.connectionLimit += 1;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        const role = f.native.runtimeRoles[0];
        if (role) role.roleReadOnly = true;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.readmission.executionActor.id =
          "33333333-3333-4333-8333-333333333333";
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.readmission.approvalAuthority.delegationDigest = "0".repeat(64);
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        const role = f.native.runtimeRoles[0];
        if (role) role.canLogin = false;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.effectiveApp.regions = f.effectiveApp.regions.map((region) => ({
          ...region,
          region: "same-region",
        }));
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.provider.appliedSdlHash = "0".repeat(64);
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.manualCutover.allocationReceiptId =
          "33333333-3333-4333-8333-333333333333";
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.effectiveApp.appDsnSha256 = "0".repeat(64);
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.effectiveApp.deployedSourceSha = "0".repeat(40);
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.independentRecovery.relations =
          f.independentRecovery.relations.slice(1);
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.independentRecovery.fullSchemaFingerprintSha256 = "0".repeat(64);
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.independentRecovery.providerAccount = f.provider.providerAccount;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.readmission.receiptId = "other-readmission";
      },
    ];
    for (const mutate of invalidCases) {
      const facts = registrationFacts();
      mutate(facts);
      const current = fixture({
        canonicalEndpointHost: "poly-db.fixture.example.org",
        appliedFacts: facts,
      });
      await expect(
        current.binder.registerApplied(request)
      ).rejects.toMatchObject({ code: "identity_conflict" });
      expect(current.writes()).toBe(0);
      expect(current.nativeReads()).toBe(0);
    }
  });
  it("propagates a same-row CAS conflict without inventing an applied receipt", async () => {
    const current = fixture({
      canonicalEndpointHost: "poly-db.fixture.example.org",
      appliedFacts: registrationFacts(),
      conflict: true,
    });
    await expect(current.binder.registerApplied(request)).rejects.toThrow(
      "allocation changed"
    );
    expect(current.writes()).toBe(0);
  });
});

describe("owned immutable applied evidence transport", () => {
  it("requires exact actual JSON bytes and refuses altered digests, duplicate kinds and oversized bundles", () => {
    const bytes = Buffer.from(
      JSON.stringify({ actual: "frozen-artifact", rows: 20409387 })
    );
    const artifact = {
      kind: "source-parity",
      mediaType: "application/json",
      sha256: shaBuffer(bytes),
      bytesBase64: bytes.toString("base64"),
    };
    const bundle = {
      version: 1,
      nodeId,
      environment: "production",
      artifacts: [artifact],
    };
    expect(
      DatabaseCellAppliedEvidenceBundleSchema.safeParse(bundle).success
    ).toBe(true);
    expect(
      DatabaseCellAppliedEvidenceBundleSchema.safeParse({
        ...bundle,
        artifacts: [{ ...artifact, sha256: "0".repeat(64) }],
      }).success
    ).toBe(false);
    expect(
      DatabaseCellAppliedEvidenceBundleSchema.safeParse({
        ...bundle,
        artifacts: [artifact, artifact],
      }).success
    ).toBe(false);
    const large = Buffer.from(JSON.stringify({ value: "x".repeat(200000) }));
    expect(
      DatabaseCellAppliedEvidenceBundleSchema.safeParse({
        ...bundle,
        artifacts: [
          {
            ...artifact,
            sha256: shaBuffer(large),
            bytesBase64: large.toString("base64"),
          },
        ],
      }).success
    ).toBe(false);
  });
  it("system trust owns empty custom CA composition without shared fallback", () => {
    const repoRoot = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const script = [
      "set -eu",
      'REPO_ROOT="$1"',
      'source "$REPO_ROOT/scripts/ci/lib/materialize-database-cell-placement.sh"',
      "TARGET_NODE=alpha",
      `CELL_PLACEMENT_JSON='{"publicValues":{"DATABASE_URL":"opaque-owned-current-dsn"}}'`,
      'value="$(cell_placement_composed_value alpha DATABASE_SSL_CA_CERT)"',
      '[ -z "$value" ]',
      "cell_placement_composed_value alpha DATABASE_URL",
    ].join("\n");
    expect(
      execFileSync("bash", ["-c", script, "fixture", repoRoot], {
        encoding: "utf8",
      })
    ).toBe("opaque-owned-current-dsn\n");
  });
});
