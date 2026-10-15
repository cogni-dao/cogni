// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  composeDatabaseCellDsn,
  DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS,
  DatabaseCellAppliedCustodySchema,
  DatabaseCellNativeControlFunctionObservationSchema,
  DatabaseRecoveryCellProbeBindingSchema,
} from "@/shared/secrets/database-cell-binding.data";
import {
  type AppliedDatabaseCellReceipt,
  AppliedDatabaseCellReceiptSchema,
  assessDatabaseCellBackupRuntime,
  DatabaseCellAllocationMetadataSchema,
  DatabaseCellAppliedEvidenceBundleSchema,
  qualifyAppliedSchemaEvolution,
} from "@/shared/secrets/database-cell-placement.data";
import type { DatabaseCellAppliedCustody } from "@/types/database-cell";
import {
  materializeDatabaseCellKits,
  planDatabaseCellKits,
} from "../../../../../../../scripts/lib/materialize-database-cell-kits";
import {
  composeDatabaseCellControlComponents,
  projectDatabaseCellPlacement,
  validateAppliedDatabaseCellInput,
  validateAppliedDatabaseCellProbeCustody,
  validateAppliedDatabaseCellProbeQualification,
} from "../../../../../../../scripts/lib/materialize-database-cell-placement";

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
    appliedCustody?: import("@/types/database-cell").DatabaseCellAppliedCustody;
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
          appliedCustody: async () =>
            options.appliedCustody ?? appliedCustody(),
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
    expect(
      AppliedDatabaseCellReceiptSchema.safeParse({
        ...first[0],
        binding: { ...first[0]?.binding, sourceSha: undefined },
      }).success
    ).toBe(false);
    expect(
      AppliedDatabaseCellReceiptSchema.safeParse({
        ...first[0],
        binding: {
          ...first[0]?.binding,
          sourceSha: undefined,
          manualProvenance: manualProvenance(),
        },
      }).success
    ).toBe(false);
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
function manualProvenance() {
  return {
    kind: "manual-observed" as const,
    postgresImageDigest: `sha256:${"1".repeat(64)}`,
    managedSdlSha256: "d".repeat(64),
    qualificationArtifactSha256: "2".repeat(64),
    qualifiedAt: "2026-10-15T06:58:00Z",
  };
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
    manualProvenance: manualProvenance(),
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
  const observedNow = Date.now();
  const ago = (seconds: number) =>
    new Date(observedNow - seconds * 1000).toISOString();
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
      serviceActiveState: "inactive",
      nextRunAt: new Date(observedNow + 900000).toISOString(),
      intervalSeconds: 900,
      jitterSeconds: 61,
      installedFullTimeoutSeconds: 3700,
      latestAttempt: { startedAt: ago(10), completedAt: ago(8), exitCode: 0 },
      latestCompletedBackup: {
        archiveSha256: "0".repeat(64),
        archiveBytes: 2846000000,
        snapshotStartedAt: ago(10),
        snapshotTimeBasis: "dump-command-start-conservative",
        completedAt: ago(8),
        snapshotAgeSeconds: 10,
      },
    },
    provider: {
      observedAt: ago(0),
      dseq: "123",
      providerAccount: `akash1${"a".repeat(38)}`,
      appliedSdlHash: "d".repeat(64),
      postgresImageDigest: manualProvenance().postgresImageDigest,
      manifestVersion: Buffer.alloc(32, 6).toString("base64"),
      service: {
        name: "postgres",
        observedGeneration: 2,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        total: 1,
        available: 1,
      },
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
      providerManifest: {
        observedAt: ago(0),
        services: [
          {
            name: "app",
            observedGeneration: 1,
            replicas: 1,
            updatedReplicas: 1,
            readyReplicas: 1,
            availableReplicas: 1,
            total: 1,
            available: 1,
          },
        ],
        consoleVersion: Buffer.alloc(32, 9).toString("base64"),
        chainVersion: Buffer.alloc(32, 9).toString("base64"),
        imageDigest: `sha256:${"9".repeat(64)}`,
      },
      runtimeAdoption: {
        observedAt: ago(0),
        systemIdentifier: "1234567890123456789",
        publicBootEgressIp: "192.0.2.44",
        sessions: [
          {
            role: lane.serviceRole,
            applicationName: "cogni_service",
            peerAddress: "10.233.83.0",
            count: 3,
          },
        ],
      },
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
      manualProvenance: manualProvenance(),
      appAllocationReceiptId: "88888888-8888-4888-8888-888888888888",
      primaryManifestVersion: Buffer.alloc(32, 6).toString("base64"),
      primaryServiceName: "postgres",
      appCogniKey: "fixture-app",
      appDseq: "456",
      appDsnSha256: sha(url(lane.appRole, lane.appPassword)),
      serviceDsnSha256: sha(url(lane.serviceRole, lane.servicePassword)),
      migrationConsumer: "app-database-url",
      appSdlHash: "c".repeat(64),
      appManifestVersion: Buffer.alloc(32, 9).toString("base64"),
      appImageDigest: `sha256:${"9".repeat(64)}`,
      appEgressIp: "192.0.2.44",
      appServiceName: "app",
      expectedRuntimeApplications: [
        { role: lane.serviceRole, applicationName: "cogni_service" },
      ],
      expectedRelations: relationNames,
      preservedRoleBounds: preservedRoleBounds(),
      allocationReceiptId: "22222222-2222-4222-8222-222222222222",
      systemIdentifier: "1234567890123456789",
      appSourceSha: appSha,
      sourceSystemIdentifier: "12",
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
      snapshotTimeBasis: "service-start-conservative",
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
  it("accepts only the actual canonical read-only probe custody reference", () => {
    const custody = appliedCustody();
    const probe = {
      dsn: composeDatabaseCellDsn(
        { host: custody.canonicalEndpointHost, port: 15432 },
        custody.databaseName,
        "probe_alpha",
        "f".repeat(48)
      ),
      custodyRef: {
        service: "alpha-database-recovery-probe",
        key: "DATABASE_RECOVERY_PROBE_URL",
      },
    };
    expect(
      DatabaseCellAppliedCustodySchema.safeParse({
        ...custody,
        readOnlyProbe: probe,
      }).success
    ).toBe(true);
    expect(
      DatabaseCellAppliedCustodySchema.safeParse({
        ...custody,
        readOnlyProbe: {
          ...probe,
          custodyRef: {
            ...probe.custodyRef,
            service: "another-database-recovery-probe",
          },
        },
      }).success
    ).toBe(false);
    expect(
      DatabaseCellAppliedCustodySchema.safeParse({
        ...custody,
        readOnlyProbe: {
          ...probe,
          dsn: probe.dsn.replace("probe_alpha", "postgres"),
        },
      }).success
    ).toBe(false);
  });
  it("bounds both service pools plus the leader with reserves and pins the same registered public policy", async () => {
    const limits = { replicaCount: 1 as const, app: 3, service: 4, read: 2 };
    const custody = { ...appliedCustody(), runtimePoolLimits: limits };
    expect(DatabaseCellAppliedCustodySchema.safeParse(custody).success).toBe(
      true
    );
    for (const invalid of [
      { ...limits, app: 4 },
      { ...limits, service: 6 },
      { ...limits, read: 3 },
      { ...limits, replicaCount: 2 },
    ])
      expect(
        DatabaseCellAppliedCustodySchema.safeParse({
          ...custody,
          runtimePoolLimits: invalid,
        }).success
      ).toBe(false);
    const facts = registrationFacts();
    facts.effectiveApp.runtimePoolLimits = limits;
    facts.manualCutover.runtimePoolLimits = limits;
    const current = fixture({ appliedFacts: facts, appliedCustody: custody });
    const receipts = await current.binder.registerApplied(request);
    expect(receipts[0]?.registration?.runtimePoolLimits).toEqual(limits);
    expect(
      projectDatabaseCellPlacement({ receipt: receipts[0], custody })
    ).toMatchObject({ runtimePoolLimits: limits });
    expect(() =>
      projectDatabaseCellPlacement({
        receipt: receipts[0],
        custody: { ...custody, runtimePoolLimits: { ...limits, app: 2 } },
      })
    ).toThrow(/custody differs/);
    facts.effectiveApp.runtimePoolLimits = { ...limits, app: 2 };
    await expect(
      fixture({
        appliedFacts: facts,
        appliedCustody: custody,
      }).binder.registerApplied(request)
    ).rejects.toMatchObject({ code: "identity_conflict" });
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
    expect(receipts[0]?.binding.sourceSha).toBeUndefined();
    expect(receipts[0]?.binding.manualProvenance).toEqual(manualProvenance());
    expect(
      AppliedDatabaseCellReceiptSchema.safeParse({
        ...receipts[0],
        binding: { ...receipts[0]?.binding, sourceSha },
      }).success
    ).toBe(false);
    expect(() =>
      projectDatabaseCellPlacement({
        receipt: receipts[0],
        custody: appliedCustody(),
        requireApplied: true,
      })
    ).toThrow("requires real reviewed native control");
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
  it("accepts a genuine running oneshot without inventing its next timer timestamp", async () => {
    const facts = registrationFacts();
    facts.backupRuntime.nextRunAt = null;
    facts.backupRuntime.serviceActiveState = "active";
    facts.backupRuntime.latestAttempt.completedAt = null;
    facts.backupRuntime.latestAttempt.exitCode = null;
    const current = fixture({ appliedFacts: facts });
    await expect(current.binder.registerApplied(request)).resolves.toHaveLength(
      1
    );
    expect(current.writes()).toBe(1);
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
  it("refuses absent native session evidence without accepting malformed observer facts", async () => {
    const facts = registrationFacts();
    facts.effectiveApp.runtimeAdoption.sessions = [];
    const current = fixture({ appliedFacts: facts });
    await expect(current.binder.registerApplied(request)).rejects.toMatchObject(
      { code: "ledger_unavailable" }
    );
    expect(current.writes()).toBe(0);
  });
  it("refuses wrong managed allocation, current DSNs, app SHA, partial recovery, schema drift and same-provider recovery", async () => {
    const invalidCases = [
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.provider.manifestVersion = Buffer.alloc(32, 7).toString("base64");
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.provider.service.total = 2;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.manualCutover.appDsnSha256 = "0".repeat(64);
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        const service = f.effectiveApp.providerManifest.services[0];
        if (service) service.updatedReplicas = 0;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        const service = f.effectiveApp.providerManifest.services[0];
        if (service) service.total = 2;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        const session = f.effectiveApp.runtimeAdoption.sessions[0];
        if (session) session.applicationName = "foreign_observer";
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.effectiveApp.providerManifest.consoleVersion = Buffer.alloc(
          32,
          8
        ).toString("base64");
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.effectiveApp.runtimeAdoption.publicBootEgressIp = "192.0.2.45";
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        const session = f.effectiveApp.runtimeAdoption.sessions[0];
        if (session) session.role = "foreign_role";
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.backupRuntime.nextRunAt = null;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        f.provider.postgresImageDigest = `sha256:${"0".repeat(64)}`;
      },
      (f: Mutable<DatabaseCellAppliedRegistrationFacts>) => {
        const role = f.manualCutover.preservedRoleBounds[0];
        if (role) role.tempFileLimitMiB += 1;
      },
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

function addQualifiedControl(
  custody: DatabaseCellAppliedCustody,
  facts: Mutable<DatabaseCellAppliedRegistrationFacts>
) {
  const endpoint = { host: custody.canonicalEndpointHost, port: 15432 };
  const logicalDsn = composeDatabaseCellDsn(
    endpoint,
    custody.databaseName,
    "probe_alpha",
    "4".repeat(64)
  );
  const controlDsn = composeDatabaseCellDsn(
    endpoint,
    "postgres",
    "probe_alpha",
    "4".repeat(64)
  );
  const actuatorDsn = composeDatabaseCellDsn(
    endpoint,
    "postgres",
    "database_reliability_actuator",
    "5".repeat(64)
  );
  const readmitDsn = composeDatabaseCellDsn(
    endpoint,
    "postgres",
    "database_reliability_readmitter",
    "6".repeat(64)
  );
  const logicalProbeFunction = {
    signature: "public.database_recovery_probe()" as const,
    definitionSha256: "7".repeat(64),
    owner: "postgres" as const,
    securityDefiner: true as const,
    publicCanExecute: false as const,
    probeCanExecute: true as const,
    searchPath: "pg_catalog, pg_temp",
  };
  const qualified = {
    version: 1 as const,
    nodeId,
    nodeSlug: custody.nodeSlug,
    environment: "production" as const,
    controlDatabaseName: "postgres" as const,
    databaseName: custody.databaseName,
    systemIdentifier: facts.native.systemIdentifier,
    allocationReceiptId: facts.manualCutover.allocationReceiptId,
    dseq: facts.provider.dseq,
    providerAccount: facts.provider.providerAccount,
    reviewedSourceSha: "9".repeat(40),
    migrationManifestSha256: "8".repeat(64),
    installedAt: facts.readmission.admittedAt,
    observedAt: facts.observedAt,
    admission: {
      manualPacketSha256: facts.manualCutover.packetSha256,
      readmissionReceiptSha256: facts.readmission.receiptId,
      admittedAt: facts.readmission.admittedAt,
      importedAt: facts.readmission.admittedAt,
      executionActor: facts.manualCutover.executionActor,
      approvalAuthority: facts.manualCutover.approvalAuthority,
    },
    requiredFunctions: DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.map((fn) => ({
      ...fn,
      definitionSha256: "a".repeat(64),
      owner: "postgres" as const,
      publicCanExecute: false as const,
      searchPath: "pg_catalog, pg_temp",
    })),
    logicalProbeFunction,
    exactRoleBounds: facts.manualCutover.preservedRoleBounds,
  };
  const bytes = Buffer.from(JSON.stringify(qualified));
  const artifact = {
    kind: "native-control-qualification" as const,
    mediaType: "application/json" as const,
    sha256: shaBuffer(bytes),
    bytesBase64: bytes.toString("base64"),
  };
  return {
    custody: {
      ...custody,
      readOnlyProbe: {
        dsn: logicalDsn,
        custodyRef: {
          service: "alpha-database-recovery-probe",
          key: "DATABASE_RECOVERY_PROBE_URL",
        },
      },
      nativeControl: {
        provenance: {
          version: 1 as const,
          controlDatabaseName: "postgres" as const,
          reviewedSourceSha: qualified.reviewedSourceSha,
          migrationManifestSha256: qualified.migrationManifestSha256,
          systemIdentifier: qualified.systemIdentifier,
          installedAt: qualified.installedAt,
          qualifiedAt: qualified.observedAt,
          qualificationReceiptSha256: artifact.sha256,
          logicalProbeDefinitionSha256: logicalProbeFunction.definitionSha256,
          functions: qualified.requiredFunctions.map(
            ({ signature, definitionSha256 }) => ({
              signature,
              definitionSha256,
            })
          ),
          custody: {
            probe: {
              service: "alpha-database-recovery-probe",
              key: "DATABASE_CELL_CONTROL_PROBE_URL",
              dsnSha256: shaBuffer(Buffer.from(controlDsn)),
            },
            actuator: {
              service: "alpha-database-cell-actuator",
              key: "DATABASE_CELL_ACTUATOR_URL",
              dsnSha256: shaBuffer(Buffer.from(actuatorDsn)),
            },
            readmitter: {
              service: "alpha-database-cell-readmitter",
              key: "DATABASE_CELL_READMIT_URL",
              dsnSha256: shaBuffer(Buffer.from(readmitDsn)),
            },
          },
        },
        probe: {
          dsn: controlDsn,
          custodyRef: {
            service: "alpha-database-recovery-probe",
            key: "DATABASE_CELL_CONTROL_PROBE_URL",
          },
        },
      },
    },
    qualified,
    controlMaterial: { actuatorDsn, readmitDsn },
    evidenceBundle: {
      version: 1 as const,
      nodeId,
      environment: "production" as const,
      artifacts: [artifact],
    },
  };
}

describe("genuine installed control on admitted manual cells", () => {
  const request = {
    cogniKey: "fixture-cell",
    nodeId,
    allocationEnvironment: "production",
    manualCutoverPacketSha256: "f".repeat(64),
    readmissionReceiptId: "e".repeat(64),
  };
  it("prepares only scoped set-once control components without inventing installation or changing consumer DSNs", async () => {
    const facts = registrationFacts();
    facts.readmission.receiptId = request.readmissionReceiptId;
    const custody = appliedCustody();
    const current = fixture({ appliedFacts: facts, appliedCustody: custody });
    const [receipt] = await current.binder.registerApplied(request);
    const value = {
      receipt,
      custody: {
        ...custody,
        readOnlyProbe: {
          dsn: composeDatabaseCellDsn(
            { host: custody.canonicalEndpointHost, port: 15432 },
            custody.databaseName,
            "probe_alpha",
            "4".repeat(64)
          ),
          custodyRef: {
            service: "alpha-database-recovery-probe",
            key: "DATABASE_RECOVERY_PROBE_URL",
          },
        },
      },
      actuatorPassword: "5".repeat(64),
      readmitPassword: "6".repeat(64),
    };
    const plan = composeDatabaseCellControlComponents(value);
    expect(plan.components).toHaveLength(5);
    expect(plan.components.map((item) => item.service)).not.toContain("alpha");
    expect(plan.components[0]?.value).toContain(
      "/postgres?sslmode=verify-full"
    );
    expect(() =>
      composeDatabaseCellControlComponents({
        ...value,
        readmitPassword: value.actuatorPassword,
      })
    ).toThrow(/distinct/);
    expect(() =>
      composeDatabaseCellControlComponents({
        ...value,
        receipt: {
          ...receipt,
          binding: { ...receipt?.binding, phase: "ready" },
        },
      })
    ).toThrow();
  });
  it("adds actual qualified control with the same-row CAS, projects distinct private capabilities and refuses unqualified activation", async () => {
    const facts = registrationFacts();
    facts.readmission.receiptId = request.readmissionReceiptId;
    const custody: DatabaseCellAppliedCustody = appliedCustody();
    const current = fixture({ appliedFacts: facts, appliedCustody: custody });
    const [original] = await current.binder.registerApplied(request);
    const control = addQualifiedControl(custody, facts);
    Object.assign(custody, control.custody);
    facts.nativeControl = control.qualified;
    const [receipt] = await current.binder.registerApplied(request);
    expect(current.writes()).toBe(2);
    expect(receipt?.registration).toEqual(original?.registration);
    expect(receipt?.binding.sourceSha).toBeUndefined();
    await current.binder.registerApplied(request);
    expect(current.writes()).toBe(2);
    expect(() =>
      projectDatabaseCellPlacement({ receipt, custody, requireApplied: true })
    ).toThrow(/requires real reviewed/);
    const projected = projectDatabaseCellPlacement({
      receipt,
      custody,
      requireApplied: true,
      controlMaterial: control.controlMaterial,
      evidenceBundle: control.evidenceBundle,
    });
    expect(projected.probe).toMatchObject({
      version: 2,
      controlDatabaseName: "postgres",
      allocationReceiptId: facts.manualCutover.allocationReceiptId,
      logicalProbeDsn: control.custody.readOnlyProbe.dsn,
    });
    expect(projected.probe).not.toHaveProperty("sourceSha");
    expect(projected.probe).not.toHaveProperty("tlsCaCertificate");
    expect(projected.admin).not.toHaveProperty("logicalProbeDsn");
    expect(projected.retireSourceBinding).toEqual({
      nodeId,
      environment: "production",
      systemIdentifier: "12",
    });
    expect(
      DatabaseRecoveryCellProbeBindingSchema.safeParse({
        ...(projected.probe as object),
        sourceSha,
      }).success
    ).toBe(false);
    expect(() =>
      projectDatabaseCellPlacement({
        receipt,
        custody,
        requireApplied: true,
        controlMaterial: {
          ...control.controlMaterial,
          actuatorDsn: control.controlMaterial.readmitDsn,
        },
        evidenceBundle: control.evidenceBundle,
      })
    ).toThrow();
    facts.nativeControl.logicalProbeFunction.definitionSha256 = "0".repeat(64);
    await expect(current.binder.registerApplied(request)).rejects.toMatchObject(
      { code: "identity_conflict" }
    );
  });
  it("retires only the exact authenticated legacy source binding and refuses ambiguous or foreign native identity", () => {
    const repoRoot = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const source = {
      nodeId,
      environment: "production",
      systemIdentifier: "12",
    };
    const siblings = [
      {
        nodeId,
        environment: "preview",
        systemIdentifier: "12",
        opaque: "preserve-preview",
      },
      {
        nodeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        environment: "production",
        systemIdentifier: "12",
        opaque: "preserve-neighbor",
      },
    ];
    const script = [
      "set -eu",
      'REPO_ROOT="$1"',
      'source "$REPO_ROOT/scripts/ci/lib/materialize-database-cell-placement.sh"',
      'input="$(cat)"',
      'fixture_prior="$(jq -c .prior <<<"$input")"',
      'projection="$(jq -c .projection <<<"$input")"',
      "DEPLOY_ENVIRONMENT=production; SECRETS_CONTROL_ENV=production",
      `node_id_for_target() { printf '%s' '${nodeId}'; }`,
      'fail() { echo "scoped retirement refused" >&2; exit 1; }',
      "prefetch_path() { :; }",
      'bao_get_field() { if [[ "$2" == DATABASE_RECOVERY_PROBE_URLS_JSON ]]; then printf "%s" "$fixture_prior"; else printf "[]"; fi; }',
      'cell_seed_exact() { if [[ "$2" == DATABASE_RECOVERY_PROBE_URLS_JSON ]]; then result="$3"; fi; }',
      "flush_batch() { :; }",
      'publish_database_cell_projection alpha "$projection"',
      'printf "%s" "$result"',
    ].join("\n");
    const run = (prior: unknown[]) =>
      JSON.parse(
        execFileSync("bash", ["-c", script, "fixture", repoRoot], {
          encoding: "utf8",
          input: JSON.stringify({
            prior,
            projection: {
              retireSourceBinding: source,
              probe: null,
              admin: null,
              readmit: null,
              backup: null,
              publicValues: null,
            },
          }),
          stdio: ["pipe", "pipe", "pipe"],
        })
      );
    expect(run([source, ...siblings])).toEqual(siblings);
    expect(run(siblings)).toEqual(siblings);
    expect(() =>
      run([{ ...source, systemIdentifier: "unexpected" }, ...siblings])
    ).toThrow();
    expect(() => run([source, source, ...siblings])).toThrow();
  });
  it("rejects widened function capabilities and unsafe search paths against the fixed reviewed signature set", () => {
    const fn = {
      ...DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS[0],
      definitionSha256: "a".repeat(64),
      owner: "postgres",
      publicCanExecute: false,
      searchPath: "pg_catalog, pg_temp",
    };
    expect(
      DatabaseCellNativeControlFunctionObservationSchema.safeParse(fn).success
    ).toBe(true);
    for (const changed of [
      { ...fn, probeCanExecute: true },
      { ...fn, publicCanExecute: true },
      { ...fn, searchPath: "pg_temp, pg_catalog" },
      { ...fn, signature: "public.forged()" },
    ])
      expect(
        DatabaseCellNativeControlFunctionObservationSchema.safeParse(changed)
          .success
      ).toBe(false);
  });
});

describe("separate canonical post-restore schema evolution", () => {
  function evolutionFixture() {
    const tag = "0002_fixture";
    const marker = `COGNI_MIGRATION_RECEIPT_V1 ${JSON.stringify({
      node: "poly",
      declared: ["0000_fixture", "0001_fixture", tag],
      applied: [
        { tag: "0000_fixture", hash: "old-unrepaired-hash", appliedAtMs: 1 },
        {
          tag: "0001_fixture",
          hash: "another-historical-hash",
          appliedAtMs: 2,
        },
        { tag, hash: "7".repeat(64), appliedAtMs: 3 },
      ],
    })}\n`;
    const before = {
      copyHeader: "COPY public.execution_requests (id) FROM stdin;",
      rows: 2,
      sha256Sum: "1".repeat(64),
      sha256Xor: "2".repeat(64),
    };
    return {
      version: 1,
      event: "poly_schema_evolution_applied",
      nodeId,
      environment: "production",
      systemIdentifier: "1234567890123456789",
      database: "cogni_alpha",
      targetAppSha: appSha,
      fromMigrationCount: 2,
      toMigrationCount: 3,
      startedAt: new Date(Date.now() - 2000).toISOString(),
      completedAt: new Date(Date.now() - 1000).toISOString(),
      migration: { tag, index: 2, when: 3, sqlSha256: "7".repeat(64) },
      newColumns: [
        {
          name: "updated_at",
          type: "timestamp with time zone",
          notNull: true,
          default: "now()",
        },
      ],
      oldDefinitionSha256Before: "3".repeat(64),
      oldDefinitionSha256After: "3".repeat(64),
      preservedData: {
        relation: "public.execution_requests",
        columns: ["id"],
        before,
        after: { ...before },
      },
      preservedJournal: {
        rowCount: 2,
        method: "canonical-json-id-hash-created_at.v1",
        beforeSha256: "4".repeat(64),
        afterSha256: "4".repeat(64),
      },
      currentJournal: {
        rowCount: 3,
        method: "canonical-json-id-hash-created_at.v1",
        sha256: "5".repeat(64),
      },
      canonicalMigrator: {
        lockKey: "0x436f676e6901",
        exitCode: 0,
        receipt: {
          bytesBase64: Buffer.from(marker).toString("base64"),
          sha256: shaBuffer(Buffer.from(marker)),
        },
      },
    };
  }
  it("authenticates actual canonical marker bytes, preserves historical hash drift and refuses altered old data/schema/journal", () => {
    const value = evolutionFixture();
    expect(qualifyAppliedSchemaEvolution(value).toMigrationCount).toBe(3);
    for (const bad of [
      { ...value, oldDefinitionSha256After: "0".repeat(64) },
      {
        ...value,
        preservedData: {
          ...value.preservedData,
          after: { ...value.preservedData.after, rows: 1 },
        },
      },
      {
        ...value,
        preservedJournal: {
          ...value.preservedJournal,
          afterSha256: "0".repeat(64),
        },
      },
      {
        ...value,
        canonicalMigrator: {
          ...value.canonicalMigrator,
          receipt: {
            ...value.canonicalMigrator.receipt,
            sha256: "0".repeat(64),
          },
        },
      },
      {
        ...value,
        migration: { ...value.migration, sqlSha256: "0".repeat(64) },
      },
    ])
      expect(() => qualifyAppliedSchemaEvolution(bad)).toThrow();
  });
  it("pins separate evolution to the admitted build and freshly observed current native journal", async () => {
    const facts = registrationFacts();
    const ref = {
      cogniKey: "fixture-cell",
      nodeId,
      allocationEnvironment: "production",
      manualCutoverPacketSha256: "f".repeat(64),
      readmissionReceiptId: facts.readmission.receiptId,
    };
    facts.manualCutover.schemaEvolution = { receiptSha256: "6".repeat(64) };
    const current = fixture({ appliedFacts: facts });
    await expect(current.binder.registerApplied(ref)).rejects.toThrow(
      /schema evolution/
    );
    facts.native.migrationJournal = {
      rowCount: 89,
      sha256: "5".repeat(64),
      observedAt: facts.observedAt,
    };
    facts.schemaEvolution = {
      receiptSha256: "6".repeat(64),
      nodeId,
      environment: "production",
      systemIdentifier: facts.native.systemIdentifier,
      targetAppSha: appSha,
      fromMigrationCount: 88,
      toMigrationCount: 89,
      migrationSqlSha256: "7".repeat(64),
      currentJournalSha256: "5".repeat(64),
      completedAt: facts.manualCutover.approvedAt,
      observedAt: facts.observedAt,
    };
    const [receipt] = await current.binder.registerApplied(ref);
    expect(receipt?.registration?.schemaEvolutionReceiptSha256).toBe(
      "6".repeat(64)
    );
    expect(facts.scheduledBackup.relations).toHaveLength(68);
    facts.native.migrationJournal.sha256 = "0".repeat(64);
    await expect(current.binder.registerApplied(ref)).rejects.toThrow(
      /current native schema journal/
    );
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

describe("readonly initial probe custody bootstrap", () => {
  it("skips factory source discovery for declared external placement while the target still requires its applied receipt", () => {
    const repoRoot = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const script = [
      "set -euo pipefail",
      'REPO_ROOT="$1" APP_SOURCE_DIR="$1"',
      'CATALOG_DIR="$REPO_ROOT/infra/catalog"',
      "TARGET_NODE=operator RELIABILITY_CONTROLLER=operator DEPLOY_ENVIRONMENT=production SECRETS_CONTROL_ENV=production DOMAIN=cognidao.org",
      "NODE_TARGETS=(poly)",
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
      'prefetch_path() { fail "unexpected factory custody read"; }',
      'remote() { fail "unexpected source database census"; }',
      'source "$REPO_ROOT/scripts/ci/lib/materialize-database-cell-kits.sh"',
      // No pending private input is seeded during this operator rollout.
      "materialize_database_cell_applied_custodies() { :; }",
      "materialize_database_cell_kits",
      'printf "factory-skipped\\n"',
      'source "$REPO_ROOT/scripts/ci/lib/materialize-database-cell-placement.sh"',
      "TARGET_NODE=poly",
      "prefetch_path() { :; }",
      "bao_get_field() { :; }",
      "load_database_cell_placement",
      'fail "unqualified target materialization accepted"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script, "fixture", repoRoot], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("factory-skipped\n");
    expect(result.stderr).toContain(
      "declared cell placement has no applied allocation receipt"
    );
  });

  async function prepared() {
    const facts = registrationFacts();
    const password = "a".repeat(64);
    const custody = {
      ...appliedCustody(),
      readOnlyProbe: {
        dsn: composeDatabaseCellDsn(
          { host: "poly-db.fixture.example.org", port: 15432 },
          "cogni_alpha",
          "probe_alpha",
          password
        ),
        custodyRef: {
          service: "alpha-database-recovery-probe",
          key: "DATABASE_RECOVERY_PROBE_URL",
        },
      },
    };
    const artifact = (
      kind: "manual-cutover" | "readmission",
      data: unknown
    ) => {
      const bytes = Buffer.from(JSON.stringify(data));
      return {
        kind,
        mediaType: "application/json",
        sha256: shaBuffer(bytes),
        bytesBase64: bytes.toString("base64"),
      };
    };
    const manual = artifact("manual-cutover", {
      nodeId,
      nodeSlug: "alpha",
      environment: "production",
      primary: {
        allocationReceiptId: facts.manualCutover.allocationReceiptId,
        systemIdentifier: facts.native.systemIdentifier,
      },
      sourceFence: {
        systemIdentifier: facts.manualCutover.sourceSystemIdentifier,
      },
    });
    const readmit = artifact("readmission", { actual: "readonly-fixture" });
    facts.manualCutover.packetSha256 = manual.sha256;
    facts.readmission.packetSha256 = manual.sha256;
    facts.readmission.receiptId = readmit.sha256;
    const reference = {
      cogniKey: "fixture-cell",
      nodeId,
      allocationEnvironment: "production",
      manualCutoverPacketSha256: manual.sha256,
      readmissionReceiptId: readmit.sha256,
    };
    const current = fixture({ appliedFacts: facts, appliedCustody: custody });
    const qualification = await current.binder.qualifyAppliedProbe(reference);
    const bundle = {
      version: 1,
      nodeId,
      environment: "production",
      artifacts: [manual, readmit],
    };
    const { allocationEnvironment: _lane, ...referenceOnly } = reference;
    return {
      facts,
      custody,
      password,
      current,
      qualification,
      bundle,
      reference,
      referenceOnly,
    };
  }
  it("fully qualifies native identity without saving APPLIED history and keeps ordinary registration strict", async () => {
    const value = await prepared();
    expect(value.current.writes()).toBe(0);
    expect(await value.current.binder.read(value.reference)).toEqual([]);
    expect(value.qualification.systemIdentifier).toBe(
      value.facts.native.systemIdentifier
    );
    expect(value.qualification).not.toHaveProperty("dsn");
    expect(
      validateAppliedDatabaseCellInput(
        value.custody,
        "alpha",
        nodeId,
        "DATABASE_CELL_APPLIED_CUSTODY_JSON"
      )
    ).toEqual(value.custody);
    expect(
      validateAppliedDatabaseCellInput(
        value.bundle,
        "alpha",
        nodeId,
        "DATABASE_CELL_APPLIED_EVIDENCE_BUNDLE_JSON"
      )
    ).toEqual(value.bundle);
    for (const [input, owner, key] of [
      [value.custody, "foreign", "DATABASE_CELL_APPLIED_CUSTODY_JSON"],
      [
        { ...value.custody, environment: "preview" },
        "alpha",
        "DATABASE_CELL_APPLIED_CUSTODY_JSON",
      ],
      [value.bundle, "foreign", "DATABASE_CELL_APPLIED_EVIDENCE_BUNDLE_JSON"],
      [value.custody, "alpha", "DATABASE_CELL_PLACEMENT_RECEIPT_JSON"],
    ] as const)
      expect(() =>
        validateAppliedDatabaseCellInput(input, owner, nodeId, key)
      ).toThrow();
    expect(
      validateAppliedDatabaseCellProbeCustody({
        custody: value.custody,
        password: value.password,
      })
    ).toEqual(value.custody);
    expect(
      validateAppliedDatabaseCellProbeQualification({
        custody: value.custody,
        bundle: value.bundle,
        qualification: value.qualification,
        reference: value.referenceOnly,
      })
    ).toEqual(value.qualification);
    const [applied] = await value.current.binder.registerApplied(
      value.reference
    );
    expect(value.current.writes()).toBe(1);
    const projection = projectDatabaseCellPlacement({
      receipt: applied,
      custody: value.custody,
    });
    expect(projection.logicalProbeDsn).toBe(value.custody.readOnlyProbe.dsn);
    expect(projection.publicValues).not.toHaveProperty(
      "DATABASE_RECOVERY_PROBE_URL"
    );
    const repoRoot = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const rendered = execFileSync(
      "bash",
      [
        "-c",
        'set -eu; REPO_ROOT="$1"; source "$REPO_ROOT/scripts/ci/lib/materialize-database-cell-placement.sh"; TARGET_NODE=alpha; CELL_PLACEMENT_JSON="$2"; cell_placement_composed_value alpha DATABASE_RECOVERY_PROBE_URL',
        "fixture",
        repoRoot,
        JSON.stringify(projection),
      ],
      { encoding: "utf8" }
    );
    expect(rendered.trim()).toBe(value.custody.readOnlyProbe.dsn);
  });
  it("refuses wrong passwords, native identities, owners and ambiguous immutable artifacts", async () => {
    const value = await prepared();
    expect(() =>
      validateAppliedDatabaseCellProbeCustody({
        custody: value.custody,
        password: "wrong",
      })
    ).toThrow();
    for (const mutate of [
      { systemIdentifier: "999" },
      { nodeId: "99999999-9999-4999-8999-999999999999" },
      { manualCutoverPacketSha256: "0".repeat(64) },
    ]) {
      const { qualificationSha256: _digest, ...core } = {
        ...value.qualification,
        ...mutate,
      };
      const qualification = {
        ...core,
        qualificationSha256: shaBuffer(Buffer.from(JSON.stringify(core))),
      };
      expect(() =>
        validateAppliedDatabaseCellProbeQualification({
          custody: value.custody,
          bundle: value.bundle,
          qualification,
          reference: value.referenceOnly,
        })
      ).toThrow();
    }
    expect(() =>
      validateAppliedDatabaseCellProbeQualification({
        custody: value.custody,
        bundle: {
          ...value.bundle,
          artifacts: [...value.bundle.artifacts, value.bundle.artifacts[0]],
        },
        qualification: value.qualification,
        reference: value.referenceOnly,
      })
    ).toThrow();
    value.facts.native.systemIdentifier = "999";
    await expect(
      value.current.binder.qualifyAppliedProbe(value.reference)
    ).rejects.toThrow();
    expect(value.current.writes()).toBe(0);
  });
  it("publishes only logical URL after real qualification and rejects owner/password/native/KV races", async () => {
    const value = await prepared();
    const repoRoot = fileURLToPath(
      new URL("../../../../../../../", import.meta.url)
    );
    const work = mkdtempSync(join(tmpdir(), "cell-probe-bootstrap-"));
    const script = [
      "set -eu",
      'REPO_ROOT="$1"',
      'CACHE_DIR="$2"',
      'source "$REPO_ROOT/scripts/ci/lib/materialize-database-cell-placement.sh"',
      "TARGET_NODE=operator; RELIABILITY_CONTROLLER=operator; DEPLOY_ENVIRONMENT=production; SECRETS_CONTROL_ENV=production; SECRET_MATERIALIZE_PHASE=database-cell-probe-custody",
      'NODE_TARGETS=(alpha); [[ "$CASE" != ambiguous ]] || NODE_TARGETS=(alpha alpha)',
      'DATABASE_CELL_CONTROL_NODE_ID="$NODE_ID"; DATABASE_CELL_REGISTER_COGNI_KEY=fixture-cell; DATABASE_CELL_REGISTER_PACKET_SHA256="$PACKET_SHA"; DATABASE_CELL_REGISTER_READMISSION_SHA256="$READMIT_SHA"',
      '[[ "$CASE" != wrongowner ]] || TARGET_NODE=alpha',
      '[[ "$CASE" != missingref ]] || DATABASE_CELL_REGISTER_PACKET_SHA256=""',
      'fail() { echo "$*" >&2; exit 39; }',
      'node_id_for_target() { printf "%s" "$NODE_ID"; }',
      "prefetch_path() { :; }",
      'bao_get_field() { case "$1/$2" in alpha-database-cell/DATABASE_CELL_APPLIED_CUSTODY_JSON) printf "%s" "$CUSTODY";; alpha-database-cell/DATABASE_CELL_APPLIED_EVIDENCE_BUNDLE_JSON) printf "%s" "$BUNDLE";; alpha/DATABASE_URL) printf "%s" "$APP_DSN";; alpha/DATABASE_SERVICE_URL) printf "%s" "$SERVICE_DSN";; *) fail "unexpected bank read";; esac; }',
      'materialize_database_cell_applied_custodies() { [[ "$1" == alpha && "$2" == probe-repair ]]; }',
      'cell_actor_http() { [[ "$1" == /v1/akash/database-cell-binding/qualify-applied-probe ]]; printf "%s" "$RESPONSE"; }',
      'bao_exec() { case "$2" in *"kv get"*) if [[ -f "$CACHE_DIR/read-marker" && "$CASE" == race ]]; then printf "%s" "$RACED_BANK"; else printf "%s" "$BANK"; fi; touch "$CACHE_DIR/read-marker";; *"kv patch -method=patch -cas=7"*) [[ "$1" == -i ]]; cat > "$CACHE_DIR/written";; *) fail "unexpected writer operation";; esac; }',
      "log() { :; }",
      "materialize_database_cell_probe_custody",
    ].join("\n");
    const rawBank = {
      data: {
        metadata: { version: 7 },
        data: {
          DATABASE_RECOVERY_PROBE_PASSWORD: value.password,
          DATABASE_RECOVERY_PROBE_URL: "old-source-retained",
          SIBLING: "unchanged",
        },
      },
    };
    try {
      for (const name of [
        "valid",
        "wrongowner",
        "missingref",
        "ambiguous",
        "password",
        "native",
        "race",
      ]) {
        const dir = join(work, name);
        mkdirSync(dir);
        const bank = structuredClone(rawBank);
        if (name === "password")
          bank.data.data.DATABASE_RECOVERY_PROBE_PASSWORD = "wrong";
        const qualification = structuredClone(value.qualification);
        if (name === "native") {
          qualification.systemIdentifier = "999";
          const { qualificationSha256: _sha, ...core } = qualification;
          qualification.qualificationSha256 = shaBuffer(
            Buffer.from(JSON.stringify(core))
          );
        }
        const env = {
          // biome-ignore lint/style/noProcessEnv: inherit PATH for isolated shell fixture
          ...process.env,
          CASE: name,
          NODE_ID: nodeId,
          PACKET_SHA: value.reference.manualCutoverPacketSha256,
          READMIT_SHA: value.reference.readmissionReceiptId,
          CUSTODY: JSON.stringify(value.custody),
          BUNDLE: JSON.stringify(value.bundle),
          APP_DSN: value.custody.app.dsn,
          SERVICE_DSN: value.custody.service.dsn,
          RESPONSE: JSON.stringify({ qualification }),
          BANK: JSON.stringify(bank),
          RACED_BANK: JSON.stringify({
            ...bank,
            data: { ...bank.data, metadata: { version: 8 } },
          }),
        };
        if (name === "valid") {
          execFileSync("bash", ["-c", script, "fixture", repoRoot, dir], {
            env,
            encoding: "utf8",
          });
          expect(
            JSON.parse(readFileSync(join(dir, "written"), "utf8"))
          ).toEqual({
            DATABASE_RECOVERY_PROBE_URL: value.custody.readOnlyProbe.dsn,
          });
        } else {
          expect(() =>
            execFileSync("bash", ["-c", script, "fixture", repoRoot, dir], {
              env,
              encoding: "utf8",
              stdio: "pipe",
            })
          ).toThrow();
          expect(existsSync(join(dir, "written"))).toBe(false);
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
