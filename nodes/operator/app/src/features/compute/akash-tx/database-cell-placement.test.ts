// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DatabaseCellBindingReferenceSchema } from "@/contracts/database-cell-binding.v1.contract";
import { DatabaseCellBinder } from "@/features/compute/akash-tx/database-cell-binding";
import type { AkashTxAllocationRecord, DatabaseCellNativeProof } from "@/ports";
import type { AppliedDatabaseCellReceipt } from "@/shared/secrets/database-cell-placement.data";
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

function fixture() {
  let saved: readonly AppliedDatabaseCellReceipt[] = [];
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
        expect(saved).toEqual(expected);
        saved = receipts;
        writes += 1;
      },
    },
    kit: async () => scopedKit,
    buildSha: sourceSha,
    observeNative: async () =>
      scopedKit.logicalDatabases.map(
        (lane): DatabaseCellNativeProof => ({
          lane,
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
      ),
  });
  return {
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
    expect(projection.backup.dsn).toContain("backup_alpha:");
    expect(projection.admin.dsn).toContain("database_reliability_actuator:");
    expect(projection.readmit.dsn).toContain(
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
