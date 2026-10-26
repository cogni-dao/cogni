// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@tests/component/db/database-cell-binding-store.int`
 * Purpose: Prove atomic physical lineage and ordinary admission exclusion on real PostgreSQL.
 * Scope: Synthetic testcontainer allocations, independent bounded clients, controlled locks.
 * Invariants: One authority, deferred-failure rollback, exact replay; no provider or real node data.
 * Side-effects: Isolated test DB rows and temporary commit-failure trigger, cleaned after each test.
 * Links: database-cell-binding-store.adapter.ts, subtask.5023
 * @internal
 */

import { createAppDbClient } from "@cogni/db-client";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { DrizzleDatabaseCellBindingStore } from "@/adapters/server/compute/database-cell-binding-store.adapter";
import type { AkashTxAllocationRecord } from "@/ports";
import type { DatabaseCellPhysicalRecoveryWrite } from "@/ports/database-cell-binding.port";
import { akashTxAllocations } from "@/shared/db/schema";
import {
  AppliedDatabaseCellReceiptsSchema,
  DatabaseCellAllocationMetadataSchema,
} from "@/shared/secrets/database-cell-placement.data";
import { getSeedDb } from "../../_fixtures/db/seed-client";

const WALLET = `akash-console:akash1${"c".repeat(38)}`;
const NODE = "5f79c3ac-7fbe-4d0f-a599-e364fb203755";
const IDENTITY = {
  nodeId: NODE,
  compositeUid: "physical-component",
  compositeGeneration: 1,
};
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (n: string) => n.repeat(64);
const sourceRecord: AkashTxAllocationRecord = {
  receiptId: id(1),
  cogniKey: "physical-source",
  identity: IDENTITY,
  workload: "fixture-database-cell",
  environment: "production",
  state: "allocated",
  retentionPolicy: "retain",
  externalName: "10001",
  providerAccount: `akash1${"d".repeat(38)}`,
  lastAppliedSdlHash: sha("a"),
};
const targetRecord: AkashTxAllocationRecord = {
  ...sourceRecord,
  receiptId: id(2),
  cogniKey: "physical-target",
  externalName: "10002",
  lastAppliedSdlHash: sha("b"),
};
const appRecord: AkashTxAllocationRecord = {
  ...sourceRecord,
  receiptId: id(3),
  cogniKey: "fixture-app",
  workload: "fixture",
  externalName: "10003",
  lastAppliedSdlHash: sha("c"),
};
const thirdRecord: AkashTxAllocationRecord = {
  ...sourceRecord,
  receiptId: id(4),
  cogniKey: "ordinary-third",
  externalName: "10004",
};
const now = new Date().toISOString();
const sourceBindings = AppliedDatabaseCellReceiptsSchema.parse([
  {
    allocationEnvironment: "production",
    targetBuildSha: "a".repeat(40),
    initialIncidentId: "fixture-native-incident",
    binding: {
      version: 1,
      phase: "applied",
      receiptId: id(1),
      cogniKey: sourceRecord.cogniKey,
      nodeId: NODE,
      nodeSlug: "fixture",
      environment: "production",
      provider: "akash",
      dseq: "10001",
      providerAccount: sourceRecord.providerAccount,
      endpoint: {
        host: "db.fixture.invalid",
        port: 5432,
        tlsMode: "verify-full",
        tlsCertificateSha256: sha("1"),
      },
      databaseName: "cogni_fixture",
      appRole: "app_fixture",
      serviceRole: "service_fixture",
      migrationRole: "migration_fixture",
      probeRole: "probe_fixture",
      systemIdentifier: "1234567890",
      failureDomainId: `akash:${sourceRecord.providerAccount}:10001`,
      sourceSha: "a".repeat(40),
      budgetProfile: "shared-default-v1",
      appliedSdlHash: sha("a"),
      readyAt: now,
      cutover: {
        packetSha256: sha("1"),
        actorId: "human:fixture",
        approvedAt: now,
      },
    },
  },
]);
const sourceBinding = sourceBindings[0]?.binding;
if (!sourceBinding) throw new Error("source fixture missing");
const { sourceSha: _sourceSha, ...targetBase } = sourceBinding;
const packetSha = sha("2");
const targetBindings = AppliedDatabaseCellReceiptsSchema.parse([
  {
    allocationEnvironment: "production",
    targetBuildSha: "a".repeat(40),
    registration: {
      kind: "audited-manual",
      physicalRecovery: {
        kind: "same-cluster-physical-copy",
        sourceCogniKey: sourceRecord.cogniKey,
        sourceReceiptId: id(1),
        sourceDseq: "10001",
        evidenceSha256: sha("3"),
        copyManifestSha256: sha("4"),
      },
      executionActor: { kind: "agent", id: "fixture-agent" },
      approvalAuthority: {
        kind: "conversation-user",
        label: "CEO",
        humanAppUserId: null,
        source: "direct-user-instruction",
        decisionRef: "test:fixture",
        capturedAt: now,
        delegationDigest: sha("5"),
      },
      readmissionReceiptId: "fixture-native-readmission",
      manualCutoverPacketSha256: packetSha,
      sourceSystemIdentifier: sourceBinding.systemIdentifier,
      preservedBackupReceiptSha256: sha("6"),
      appAllocationReceiptId: id(3),
      appSdlHash: sha("e"),
      appDsnSha256: sha("7"),
      serviceDsnSha256: sha("8"),
      migrationDsnSha256: sha("9"),
      migrationConsumer: "app-database-url",
      tlsTrustKind: "system",
      registeredAt: now,
    },
    binding: {
      ...targetBase,
      receiptId: id(2),
      cogniKey: targetRecord.cogniKey,
      dseq: "10002",
      failureDomainId: `akash:${targetRecord.providerAccount}:10002`,
      appliedSdlHash: sha("d"),
      manualProvenance: {
        kind: "manual-observed",
        postgresImageDigest: `sha256:${sha("1")}`,
        managedSdlSha256: sha("d"),
        qualificationArtifactSha256: sha("2"),
        qualifiedAt: now,
      },
      cutover: {
        packetSha256: packetSha,
        actorId: "agent:fixture-agent",
        approvedAt: now,
      },
    },
  },
]);
const write: DatabaseCellPhysicalRecoveryWrite = {
  source: sourceRecord,
  target: targetRecord,
  app: appRecord,
  expectedSource: sourceBindings,
  expectedTarget: [],
  targetBindings,
  recoveryIntentKey: targetRecord.cogniKey,
  targetSdlHash: sha("d"),
  appSdlHash: sha("e"),
  packetSha256: packetSha,
};

describe("physical recovery canonical transaction (real PostgreSQL)", () => {
  const seed = getSeedDb();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("component DATABASE_URL required");
  const first = createAppDbClient(url, {
    max: 1,
    applicationName: "physical_import_racer",
  });
  const second = createAppDbClient(url, {
    max: 1,
    applicationName: "ordinary_binding_racer",
  });
  const store = new DrizzleDatabaseCellBindingStore(async () => first, WALLET);
  const otherStore = new DrizzleDatabaseCellBindingStore(
    async () => second,
    WALLET
  );
  const ledger = new DrizzleAkashTxAllocationLedger(async () => first, WALLET);
  beforeEach(async () => {
    await seed
      .delete(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET));
    await seed.insert(akashTxAllocations).values(
      [sourceRecord, targetRecord, appRecord, thirdRecord].map((record) => ({
        id: record.receiptId,
        walletScope: WALLET,
        cogniKey: record.cogniKey,
        nodeId: NODE,
        compositeUid: IDENTITY.compositeUid,
        compositeGeneration: 1,
        workload: record.workload,
        environment: "production",
        state: "allocated",
        externalName: record.externalName,
        providerAccount: record.providerAccount,
        lastAppliedSdlHash: record.lastAppliedSdlHash,
        appliedDatabaseCellBinding: {
          version: 1,
          retentionPolicy: "retain",
          bindings: record === sourceRecord ? sourceBindings : [],
        },
      }))
    );
  });
  afterEach(async () => {
    await seed
      .delete(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET));
  });
  // Close after suite, not per case: a client must stay bounded and independently connected.
  afterAll(async () => {
    await Promise.all([first.$client.end(), second.$client.end()]);
  });
  const state = async () => {
    const rows = await seed
      .select()
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET))
      .orderBy(akashTxAllocations.id);
    return rows.map((row) => ({
      id: row.id,
      hash: row.lastAppliedSdlHash,
      metadata: DatabaseCellAllocationMetadataSchema.parse(
        row.appliedDatabaseCellBinding
      ),
    }));
  };
  it("publishes one complete lineage and exactly replays with refreshed preimages", async () => {
    await store.savePhysicalRecovery(write);
    const committed = await state();
    expect(committed[0]?.metadata.bindings[0]?.binding.phase).toBe(
      "superseded"
    );
    expect(committed[0]?.hash).toBe(sha("a"));
    expect(committed[1]?.hash).toBe(sha("d"));
    expect(committed[2]?.hash).toBe(sha("e"));
    const target = await ledger.read({ cogniKey: targetRecord.cogniKey }),
      app = await ledger.read({ cogniKey: appRecord.cogniKey });
    if (!target || !app) throw new Error("committed allocation missing");
    await store.savePhysicalRecovery({
      ...write,
      target,
      app,
      expectedSource: await store.read(sourceRecord.cogniKey),
      expectedTarget: await store.read(targetRecord.cogniKey),
    });
    expect(await state()).toEqual(committed);
    await expect(
      store.savePhysicalRecovery({
        ...write,
        target,
        app,
        packetSha256: sha("f"),
      })
    ).rejects.toThrow();
    expect(await state()).toEqual(committed);
  });
  it("rolls back all three writes when PostgreSQL rejects the transaction at commit", async () => {
    // A deferred real database trigger fails AFTER source, target and app updates.
    // This falsifies partial lineage publication; a fake store cannot prove rollback.
    await first.execute(
      sql.raw(
        `CREATE FUNCTION pg_temp.reject_physical_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.wallet_scope = '${WALLET}' AND NEW.id = '${id(3)}'::uuid THEN RAISE EXCEPTION 'fixture deferred commit rejection'; END IF; RETURN NEW; END $$`
      )
    );
    await first.execute(
      sql.raw(
        "CREATE CONSTRAINT TRIGGER physical_fixture_commit_failure AFTER UPDATE ON akash_tx_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_physical_commit()"
      )
    );
    const before = await state();
    try {
      await expect(store.savePhysicalRecovery(write)).rejects.toThrow(
        "reobserve"
      );
      expect(await state()).toEqual(before);
    } finally {
      await first.execute(
        sql.raw(
          "DROP TRIGGER physical_fixture_commit_failure ON akash_tx_allocations"
        )
      );
    }
  });
  it("excludes ordinary registration racing import with two genuinely separate clients and controlled interleaving", async () => {
    const [one] = await first.$client`select pg_backend_pid()::int as pid`;
    const [two] = await second.$client`select pg_backend_pid()::int as pid`;
    expect(one?.pid).not.toBe(two?.pid);
    let release: () => void = () => {},
      locked: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
        locked = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const barrier = seed.transaction(async (tx) => {
      await tx
        .select()
        .from(akashTxAllocations)
        .where(eq(akashTxAllocations.id, id(1)))
        .for("update");
      locked();
      await gate;
    });
    await ready;
    const incoming = store.savePhysicalRecovery(write);
    const ordinary = AppliedDatabaseCellReceiptsSchema.parse(
      sourceBindings.map((receipt) => ({
        ...receipt,
        binding: {
          ...receipt.binding,
          receiptId: id(4),
          cogniKey: thirdRecord.cogniKey,
          dseq: "10004",
          failureDomainId: `akash:${thirdRecord.providerAccount}:10004`,
        },
      }))
    );
    const pending = otherStore.save(thirdRecord, ordinary, []);
    const settled = Promise.allSettled([incoming, pending]);
    try {
      const deadline = Date.now() + 1200;
      let waiting = 0;
      do {
        const rows = await seed.execute(
          sql`select count(*)::int as count from pg_stat_activity where pid in (${one?.pid},${two?.pid}) and cardinality(pg_blocking_pids(pid)) > 0`
        );
        waiting = Number(rows[0]?.count ?? 0);
        if (waiting === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      expect(waiting).toBe(2);
    } finally {
      release();
      await barrier;
    }
    const outcomes = await settled;
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]?.status).toBe("rejected");
    const authorities = (await state()).flatMap((row) =>
      row.metadata.bindings.filter(
        (receipt) => receipt.binding.phase === "applied"
      )
    );
    expect(authorities.map((receipt) => receipt.binding.receiptId)).toEqual([
      id(2),
    ]);
  });
});
