// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres proof for receipt-linked cost attribution and native CLOSED settlement. */
import { createHash } from "node:crypto";
import { rootCertificates } from "node:tls";
import type { ProvisionSpec } from "@cogni/ai-tools";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AkashComputeAdapter } from "@/adapters/server/compute/akash-compute.adapter";
import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { DrizzleComputeCostStore } from "@/adapters/server/compute/compute-cost-store.adapter";
import { DrizzleDatabaseCellBindingStore } from "@/adapters/server/compute/database-cell-binding-store.adapter";
import {
  AkashTxActuator,
  type AkashTxLogger,
} from "@/features/compute/akash-tx/akash-tx-actuator";
import type { ComputeResourceCostEvidence } from "@/ports";
import { akashTxAllocations, computeCostIntervals } from "@/shared/db/schema";
import { DatabaseCellAppliedCustodySchema } from "@/shared/secrets/database-cell-binding.data";
import {
  AppliedDatabaseCellReceiptsSchema,
  DatabaseCellAllocationMetadataSchema,
} from "@/shared/secrets/database-cell-placement.data";

/** Account-keyed, per `akash_tx_allocations_wallet_scope_account_check` (bug.5187). */
const WALLET = "akash-console:akash1costtestwalletaddressforcomponenttests";
const NODE_ID = "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60";
const OTHER_NODE_ID = "3f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b61";
const IDENTITY = {
  nodeId: NODE_ID,
  compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
  compositeGeneration: 3,
};

function evidence(
  over: Partial<ComputeResourceCostEvidence> = {}
): ComputeResourceCostEvidence {
  return {
    computeProvider: "akash",
    resourceId: "7001",
    providerConsumerAccountId: "akash1consumer",
    providerSupplierAccountId: "akash1provider",
    rate: { amount: "7.5", denom: "uakt", unit: "block" },
    providerOpenedAtPosition: "100",
    escrow: {
      state: "open",
      funds: [{ amount: "500000", denom: "uakt" }],
      transferred: [{ amount: "10.25", denom: "uakt" }],
    },
    observedAt: new Date("2026-09-15T00:00:00.000Z"),
    ...over,
  };
}

function resource(
  resourceId: string,
  providerConsumerAccountId = "akash1consumer"
) {
  return { computeProvider: "akash", providerConsumerAccountId, resourceId };
}

describe("DrizzleComputeCostStore (Component)", () => {
  const db = getSeedDb();
  const ledger = new DrizzleAkashTxAllocationLedger(async () => db, WALLET);
  const store = new DrizzleComputeCostStore(async () => db);

  beforeEach(async () => {
    await db.delete(computeCostIntervals);
    await db
      .delete(akashTxAllocations)
      .where(eq(akashTxAllocations.walletScope, WALLET));
  });

  async function allocated(
    cogniKey = "k1",
    externalName = "7001",
    nodeId = NODE_ID
  ) {
    const claim = await ledger.claim({
      cogniKey,
      workload: "toks9",
      environment: "candidate-a",
      identity: { ...IDENTITY, nodeId },
    });
    if (claim.state !== "claimed") throw new Error("expected a fresh claim");
    await ledger.recordAllocation({
      cogniKey,
      externalName,
      providerAccount: "akash1provider",
    });
    return claim.record.receiptId;
  }

  it("binds cost only to the handle already stored on the authoritative receipt", async () => {
    const allocationReceiptId = await allocated();
    await expect(
      store.bind({
        allocationReceiptId,
        resource: resource("7999"),
      })
    ).rejects.toThrow(/durable allocation receipt/);

    await store.bind({
      allocationReceiptId,
      resource: resource("7001"),
    });
    const [row] = await db.select().from(computeCostIntervals);
    expect(row).toMatchObject({
      allocationReceiptId,
      state: "allocated",
      computeProvider: "akash",
      providerConsumerAccountId: "akash1consumer",
      resourceId: "7001",
    });
  });

  it("keeps native evidence monotonic and reports exact totals by node_id", async () => {
    const allocationReceiptId = await allocated();
    await store.bind({
      allocationReceiptId,
      resource: resource("7001"),
    });
    await store.observe({ allocationReceiptId, evidence: evidence() });
    await store.observe({
      allocationReceiptId,
      evidence: evidence({
        observedAt: new Date("2026-09-15T00:01:00.000Z"),
        escrow: {
          state: "open",
          funds: [{ amount: "500000", denom: "uakt" }],
          transferred: [{ amount: "11.75", denom: "uakt" }],
        },
      }),
    });
    const secondReceiptId = await allocated("k2", "7002");
    await store.bind({
      allocationReceiptId: secondReceiptId,
      resource: resource("7002"),
    });
    await store.observe({
      allocationReceiptId: secondReceiptId,
      evidence: evidence({
        resourceId: "7002",
        rate: { amount: "2.5", denom: "uakt", unit: "block" },
        escrow: {
          state: "open",
          funds: [{ amount: "500000", denom: "uakt" }],
          transferred: [{ amount: "3.25", denom: "uakt" }],
        },
      }),
    });

    await expect(store.reportByNode()).resolves.toEqual([
      {
        nodeId: NODE_ID,
        allocatedIntervals: 0,
        activeIntervals: 2,
        closedIntervals: 0,
        transferred: [{ amount: "15", denom: "uakt" }],
        activeRates: [{ amount: "10", denom: "uakt", unit: "block" }],
      },
    ]);

    await expect(
      store.observe({
        allocationReceiptId,
        evidence: evidence({
          observedAt: new Date("2026-09-15T00:02:00.000Z"),
          escrow: {
            state: "open",
            funds: [{ amount: "500000", denom: "uakt" }],
            transferred: [{ amount: "11.5", denom: "uakt" }],
          },
        }),
      })
    ).rejects.toThrow(/regressed/);
  });

  it("filters authorized node ids in SQL before returning cost evidence", async () => {
    const firstReceiptId = await allocated("node-a", "7101", NODE_ID);
    await store.bind({
      allocationReceiptId: firstReceiptId,
      resource: resource("7101"),
    });
    await store.observe({
      allocationReceiptId: firstReceiptId,
      evidence: evidence({ resourceId: "7101" }),
    });

    const secondReceiptId = await allocated("node-b", "7102", OTHER_NODE_ID);
    await store.bind({
      allocationReceiptId: secondReceiptId,
      resource: resource("7102"),
    });
    await store.observe({
      allocationReceiptId: secondReceiptId,
      evidence: evidence({ resourceId: "7102" }),
    });

    const reports = await store.reportByNodeIds([NODE_ID]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.nodeId).toBe(NODE_ID);
    expect(reports.some((report) => report.nodeId === OTHER_NODE_ID)).toBe(
      false
    );
    await expect(store.reportByNodeIds([])).resolves.toEqual([]);
  });

  it("ignores older evidence, rejects divergent evidence at the same position, and stays closed", async () => {
    const allocationReceiptId = await allocated();
    await store.bind({
      allocationReceiptId,
      resource: resource("7001"),
    });
    const current = evidence({
      observedAt: new Date("2026-09-15T00:02:00.000Z"),
      escrow: {
        state: "open",
        funds: [{ amount: "500000", denom: "uakt" }],
        transferred: [{ amount: "20", denom: "uakt" }],
      },
    });
    await store.observe({ allocationReceiptId, evidence: current });
    await expect(
      store.observe({
        allocationReceiptId,
        evidence: evidence({
          observedAt: new Date("2026-09-15T00:02:30.000Z"),
          escrow: {
            state: "overdrawn",
            funds: [{ amount: "-6344.131225000000000000", denom: "uakt" }],
            transferred: [{ amount: "-1.0", denom: "uakt" }],
          },
        }),
      })
    ).rejects.toThrow(/non-negative plain decimal/);
    await store.observe({
      allocationReceiptId,
      evidence: evidence({ observedAt: new Date("2026-09-15T00:01:00.000Z") }),
    });
    await expect(
      store.observe({
        allocationReceiptId,
        evidence: evidence({
          ...current,
          escrow: { ...current.escrow, state: "forged" },
        }),
      })
    ).rejects.toThrow(/same observedAt/);

    await store.observe({
      allocationReceiptId,
      evidence: evidence({
        observedAt: new Date("2026-09-15T00:03:00.000Z"),
        providerClosedAtPosition: "150",
        escrow: {
          state: "overdrawn",
          providerSettledAtPosition: "151",
          funds: [{ amount: "-6344.131225000000000000", denom: "uakt" }],
          transferred: [{ amount: "21", denom: "uakt" }],
        },
      }),
    });
    await store.observe({
      allocationReceiptId,
      evidence: evidence({
        observedAt: new Date("2026-09-15T00:04:00.000Z"),
        escrow: {
          state: "overdrawn",
          providerSettledAtPosition: "152",
          funds: [{ amount: "-6344.131225000000000000", denom: "uakt" }],
          transferred: [{ amount: "22", denom: "uakt" }],
        },
      }),
    });
    const [closed] = await db.select().from(computeCostIntervals);
    expect(closed).toMatchObject({
      state: "closed",
      providerClosedAtPosition: "150",
      providerSettledAtPosition: "152",
      escrowFunds: [{ amount: "-6344.131225000000000000", denom: "uakt" }],
      cumulativeTransferred: [{ amount: "22", denom: "uakt" }],
    });
  });

  it("scopes provider resource identity by raw consumer account", async () => {
    const first = await allocated("k1", "7001");
    await store.bind({
      allocationReceiptId: first,
      resource: resource("7001"),
    });
    await store.observe({ allocationReceiptId: first, evidence: evidence() });

    const second = await allocated("k2", "7001");
    await expect(
      store.bind({
        allocationReceiptId: second,
        resource: resource("7001"),
      })
    ).rejects.toThrow(/another receipt/);

    const third = await allocated("k3", "7001");
    await store.bind({
      allocationReceiptId: third,
      resource: resource("7001", "akash1consumer-two"),
    });
    await expect(
      store.observe({
        allocationReceiptId: third,
        evidence: evidence({
          providerConsumerAccountId: "akash1consumer-two",
        }),
      })
    ).resolves.toBeUndefined();
  });

  it("never regresses updatedAt when evidence or a later local close crosses DB time", async () => {
    const allocationReceiptId = await allocated();
    await store.bind({
      allocationReceiptId,
      resource: resource("7001"),
    });
    const future = new Date("2099-01-01T00:00:00.000Z");
    await store.observe({
      allocationReceiptId,
      evidence: evidence({ observedAt: future }),
    });
    await store.close({ allocationReceiptId });

    const [row] = await db.select().from(computeCostIntervals);
    expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(future.getTime());
  });

  // Revision4's approved local composition: production uses this SAME Console object
  // for status and cost. Only provider transport is injected; every store is real SQL.
  function nativeDetail(full = false, over: Record<string, unknown> = {}) {
    return {
      deployment: {
        id: { dseq: "7001", owner: "akash1consumer" },
        state: "closed",
      },
      leases: full
        ? [
            {
              id: {
                dseq: "7001",
                owner: "akash1consumer",
                provider: "akash1provider",
              },
              state: "closed",
              price: { amount: "7.5", denom: "uakt" },
              created_at: "100",
              closed_on: "150",
            },
          ]
        : [],
      ...(full
        ? {
            escrow_account: {
              state: {
                owner: "akash1consumer",
                state: "closed",
                settled_at: "151",
                funds: [{ amount: "499980.75", denom: "uakt" }],
                transferred: [{ amount: "19.25", denom: "uakt" }],
              },
            },
          }
        : {}),
      ...over,
    };
  }
  function composed(detail: unknown, secondRead: unknown = detail) {
    const posts: string[] = [];
    const lines: { fields: Record<string, unknown>; marker: string }[] = [];
    const capture: AkashTxLogger["info"] = (fields, marker) => {
      lines.push({ fields, marker });
    };
    const log: AkashTxLogger = { info: capture, warn: capture, error: capture };
    let reads = 0;
    const consoleClient = new AkashComputeAdapter({
      apiKey: "component-test-only",
      expectedCostConsumerAccountId: "akash1consumer",
      timeoutMs: 1000,
      now: () => new Date("2026-09-15T00:01:00.000Z"),
      outcomeStore: { record: async () => {}, stats: async () => new Map() },
      fetchImpl: async (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST") posts.push(String(url));
        if (
          method !== "GET" ||
          String(url) !==
            "https://console-api.akash.network/v1/deployments/7001"
        )
          throw new Error(`unexpected provider ${method} ${String(url)}`);
        return new Response(
          JSON.stringify({ data: ++reads === 1 ? detail : secondRead }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });
    const durableLedger = new DrizzleAkashTxAllocationLedger(
      async () => db,
      WALLET
    );
    const actuator = new AkashTxActuator({
      console: consoleClient,
      costEvidence: consoleClient,
      ledger: durableLedger,
      costStore: new DrizzleComputeCostStore(async () => db),
      providerConsumerAccountId: "akash1consumer",
      log,
    });
    return { actuator, posts, lines, ledger: durableLedger, consoleClient };
  }
  // P1 extends this file's existing feature/real-adapter composition. SQL and
  // provider transport are real owners; only forbidden paid downstream IO is doubled.
  const sha = "a".repeat(40);
  const nextSha = "b".repeat(40);
  const retainedProvider = `akash1${"a".repeat(38)}`;
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  async function retainedFixture(legacy = false) {
    const custody = DatabaseCellAppliedCustodySchema.parse({
      version: 1,
      nodeId: NODE_ID,
      nodeSlug: "toks9",
      environment: "production",
      manualProvenance: {
        kind: "manual-observed",
        postgresImageDigest: `sha256:${"1".repeat(64)}`,
        managedSdlSha256: "d".repeat(64),
        qualificationArtifactSha256: "2".repeat(64),
        qualifiedAt: "2026-10-15T00:00:00Z",
      },
      targetBuildSha: sha,
      canonicalEndpointHost: "owned.example",
      databaseName: "cogni_toks9",
      appRole: "app_toks9",
      serviceRole: "service_toks9",
      budgetProfile: "dedicated-high-throughput-v1",
      runtimePoolLimits: { replicaCount: 1, app: 3, service: 4, read: 2 },
      budget: {
        kind: "preserved-role-bounds",
        roles: ["app_toks9", "service_toks9"].map((name) => ({
          name,
          connectionLimit: 20,
          statementTimeoutMs: 5000,
          lockTimeoutMs: 2000,
          idleInTransactionTimeoutMs: 30000,
          tempFileLimitMiB: 128,
          workMemMiB: 16,
        })),
      },
      tlsCertificate: rootCertificates[0],
      tls: { kind: "system" },
      app: {
        dsn: "postgresql://app_toks9:fixture@owned.example:30349/cogni_toks9?sslmode=verify-full",
        custody: { service: "toks9", key: "DATABASE_URL" },
      },
      service: {
        dsn: "postgresql://service_toks9:fixture@owned.example:30349/cogni_toks9?sslmode=verify-full",
        custody: { service: "toks9", key: "DATABASE_SERVICE_URL" },
      },
      migration: { kind: "app-database-url" },
    });
    const c = composed(nativeDetail());
    const cellSpec: ProvisionSpec = {
      name: "toks9-database-cell",
      retentionPolicy: "retain",
      services: [
        {
          name: "postgres",
          image: custody.manualProvenance.postgresImageDigest.replace(
            "sha256:",
            "postgres:15@sha256:"
          ),
          cpuUnits: 4,
          memoryMi: 16384,
          storageMi: 1024,
          command: ["sleep"],
          args: ["infinity"],
          env: { PGDATA: "/var/lib/postgresql/data/pgdata" },
          volumes: [
            {
              name: "database",
              sizeMi: 204800,
              mountPath: "/var/lib/postgresql/data",
              tier: "nvme",
            },
          ],
          expose: [{ port: 5432, as: 5432, global: true }],
        },
      ],
    };
    const sdlHash = c.consoleClient.sdlHash(cellSpec);
    custody.manualProvenance.managedSdlSha256 = sdlHash;
    DatabaseCellAppliedCustodySchema.parse(custody);
    const claim = await ledger.claim({
      cogniKey: "retained",
      workload: cellSpec.name,
      environment: "production",
      identity: IDENTITY,
      retentionPolicy: "retain",
    });
    if (claim.state !== "claimed") throw new Error("expected retained claim");
    await ledger.recordAllocation({
      cogniKey: "retained",
      externalName: "7001",
      providerAccount: retainedProvider,
    });
    await ledger.recordAppliedSdlHash({ cogniKey: "retained", sdlHash });
    const bindings = AppliedDatabaseCellReceiptsSchema.parse([
      {
        allocationEnvironment: "production",
        targetBuildSha: sha,
        ...(legacy
          ? { initialIncidentId: "native-initial" }
          : {
              registration: {
                kind: "audited-manual",
                executionActor: { kind: "agent", id: IDENTITY.compositeUid },
                approvalAuthority: {
                  kind: "conversation-user",
                  label: "CEO",
                  humanAppUserId: null,
                  source: "direct-user-instruction",
                  decisionRef: "component-fixture",
                  capturedAt: "2026-10-15T00:00:00Z",
                  delegationDigest: "a".repeat(64),
                },
                readmissionReceiptId: "readmission",
                manualCutoverPacketSha256: "f".repeat(64),
                sourceSystemIdentifier: "456",
                scheduledBackupReceiptSha256: "b".repeat(64),
                independentRecoveryReceiptSha256: "c".repeat(64),
                appAllocationReceiptId: "33333333-3333-4333-8333-333333333333",
                appSdlHash: "d".repeat(64),
                appDsnSha256: digest(custody.app.dsn),
                serviceDsnSha256: digest(custody.service.dsn),
                migrationDsnSha256: digest(custody.app.dsn),
                migrationConsumer: "app-database-url",
                tlsTrustKind: "system",
                runtimePoolLimits: custody.runtimePoolLimits,
                registeredAt: "2026-10-15T00:00:00Z",
              },
            }),
        binding: {
          version: 1,
          phase: "applied",
          receiptId: claim.record.receiptId,
          cogniKey: "retained",
          nodeId: NODE_ID,
          nodeSlug: "toks9",
          environment: "production",
          provider: "akash",
          dseq: "7001",
          providerAccount: retainedProvider,
          endpoint: {
            host: "owned.example",
            port: 30349,
            tlsMode: "verify-full",
            tlsCertificateSha256: "c".repeat(64),
          },
          databaseName: "cogni_toks9",
          appRole: "app_toks9",
          serviceRole: "service_toks9",
          migrationRole: "migration_toks9",
          probeRole: "probe_toks9",
          systemIdentifier: "123",
          failureDomainId: `akash:${retainedProvider}:7001`,
          budgetProfile: "dedicated-high-throughput-v1",
          appliedSdlHash: sdlHash,
          ...(legacy
            ? { sourceSha: "e".repeat(40) }
            : { manualProvenance: custody.manualProvenance }),
          readyAt: "2026-10-15T00:00:00Z",
          cutover: {
            packetSha256: "f".repeat(64),
            actorId: "human:fixture",
            approvedAt: "2026-10-15T00:00:00Z",
          },
        },
      },
    ]);
    const bindingStore = new DrizzleDatabaseCellBindingStore(
      async () => db,
      WALLET
    );
    const record = await ledger.read({ cogniKey: "retained" });
    if (!record) throw new Error("missing allocated record");
    await bindingStore.save(record, bindings, []);
    const before = await ledger.read({ cogniKey: "retained" });
    if (!before) throw new Error("missing retained fixture");
    const [raw] = await db
      .select()
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.id, record.receiptId));
    expect(
      DatabaseCellAllocationMetadataSchema.parse(
        raw?.appliedDatabaseCellBinding
      )
    ).toEqual({ version: 1, retentionPolicy: "retain", bindings });
    expect(before).toMatchObject({
      ...record,
      retentionPolicy: "retain",
      appliedDatabaseCellBinding: bindings,
      lastAppliedSdlHash: sdlHash,
    });
    return { c, before, custody, bindings, bindingStore, sdlHash };
  }
  async function closeRetained(
    fixture: Awaited<ReturnType<typeof retainedFixture>>
  ) {
    const { c, before } = fixture;
    await expect(
      c.actuator.observe({ cogniKey: "retained" })
    ).resolves.toMatchObject({
      found: true,
      resource: { state: "closed", externalName: "7001" },
    });
    expect(await ledger.read({ cogniKey: "retained" })).toEqual({
      ...before,
      state: "released",
    });
    const [cost] = await db
      .select()
      .from(computeCostIntervals)
      .where(eq(computeCostIntervals.allocationReceiptId, before.receiptId));
    expect(cost).toMatchObject({
      allocationReceiptId: before.receiptId,
      resourceId: "7001",
      rateAmount: null,
      cumulativeTransferred: [],
    });
    expect(c.lines).toContainEqual(
      expect.objectContaining({
        marker: "compute_cost_unavailable",
        fields: expect.objectContaining({ accounting: "unknown" }),
      })
    );
    expect(c.posts).toEqual([]);
  }
  function releaseConsumer(
    fixture: Awaited<ReturnType<typeof retainedFixture>>,
    custodyAvailable = true
  ) {
    const restarted = composed(nativeDetail());
    const api = restarted.consoleClient;
    // All forbidden effects otherwise SUCCEED, so admission bypass cannot masquerade as refusal.
    const cursor = vi.spyOn(api, "allocationCursor").mockResolvedValue("7001");
    const create = vi
      .spyOn(api, "allocateAndLease")
      .mockImplementation(async (input) => {
        await input.onAllocated?.("7002");
        return { leaseId: "7002", providerAccount: retainedProvider };
      });
    const update = vi.spyOn(api, "updateAllocated").mockResolvedValue();
    vi.spyOn(api, "status").mockImplementation(async (input) => ({
      provider: "akash",
      leaseId: input.leaseId,
      state: "active",
      endpoints: [],
    }));
    vi.spyOn(api, "observeCost").mockImplementation(async (input) =>
      evidence({
        resourceId: input.resourceId,
        providerSupplierAccountId: retainedProvider,
      })
    );
    const ensure = vi.fn(async () => "succeeded" as const);
    const actuator = new AkashTxActuator({
      console: api,
      costEvidence: api,
      ledger: restarted.ledger,
      costStore: store,
      providerConsumerAccountId: "akash1consumer",
      migration: { ensure },
      ...(custodyAvailable
        ? { appliedCellCustody: async () => fixture.custody }
        : {}),
    });
    const spec = (): ProvisionSpec => ({
      name: "toks9",
      services: [
        {
          name: "app",
          image: "ghcr.io/example/app:fixed",
          cpuUnits: 0.5,
          memoryMi: 512,
          storageMi: 512,
          expose: [],
          env: {
            COGNI_REPO_SHA: nextSha,
            DATABASE_URL: fixture.custody.app.dsn,
            DATABASE_SERVICE_URL: fixture.custody.service.dsn,
            DATABASE_SSL_CA_CERT: rootCertificates[0] ?? "",
            DB_POOL_MAX: "3",
            DB_SERVICE_POOL_MAX: "4",
            DB_READ_POOL_MAX: "2",
          },
        },
      ],
    });
    return { actuator, cursor, create, update, ensure, spec };
  }
  async function seedApp() {
    await ledger.claim({
      cogniKey: "app",
      workload: "toks9",
      environment: "production",
      identity: IDENTITY,
    });
    await ledger.recordAllocation({
      cogniKey: "app",
      externalName: "7002",
      providerAccount: retainedProvider,
    });
    await ledger.recordAppliedSdlHash({
      cogniKey: "app",
      sdlHash: "0".repeat(64),
    });
  }
  it("P1 real retained CLOSED settlement preserves policy after restart and refuses each bad create/update before downstream IO", async () => {
    const fixture = await retainedFixture();
    await closeRetained(fixture);
    await seedApp();
    const c = releaseConsumer(fixture);
    const changes = [
      {
        DATABASE_URL:
          "postgresql://app_toks9:x@wrong.example:30349/cogni_toks9?sslmode=verify-full",
      },
      {
        DATABASE_SERVICE_URL:
          "postgresql://service_toks9:x@owned.example:30349/cogni_toks9?sslmode=disable",
      },
      {
        DATABASE_URL:
          "postgresql://app_wrong:x@owned.example:30349/cogni_toks9?sslmode=verify-full",
      },
      {
        DATABASE_URL:
          "postgresql://app_toks9:x@owned.example:30349/cogni_wrong?sslmode=verify-full",
      },
      { DATABASE_URL: fixture.custody.app.dsn.replace("30349", "30350") },
      { DATABASE_SERVICE_URL: "not-a-dsn" },
      { DATABASE_SSL_CA_CERT: "untrusted" },
      { DB_POOL_MAX: "30" },
      { DB_SERVICE_POOL_MAX: "40" },
      { DB_READ_POOL_MAX: "20" },
      { COGNI_REPO_SHA: "bad-sha" },
      { COGNI_REPO_SHA: "" },
    ];
    for (const change of changes) {
      const spec = c.spec();
      const app = spec.services[0];
      if (!app?.env) throw new Error("missing consumer");
      Object.assign(app.env, change);
      await expect(
        c.actuator.create({
          cogniKey: "new-app",
          environment: "production",
          identity: IDENTITY,
          spec,
        })
      ).rejects.toMatchObject({ code: "identity_conflict" });
      await expect(
        c.actuator.update({
          cogniKey: "app",
          externalName: "7002",
          environment: "production",
          identity: { ...IDENTITY, compositeGeneration: 4 },
          spec,
        })
      ).rejects.toMatchObject({ code: "identity_conflict" });
    }
    const mixed: ProvisionSpec = {
      ...c.spec(),
      services: [
        ...c.spec().services,
        {
          name: "worker",
          image: "ghcr.io/example/worker:fixed",
          cpuUnits: 0.5,
          memoryMi: 512,
          storageMi: 512,
          expose: [],
          env: { COGNI_REPO_SHA: sha },
        },
      ],
    };
    const missing: ProvisionSpec = {
      ...c.spec(),
      services: c.spec().services.map((service) => {
        const { COGNI_REPO_SHA: _sha, ...env } = service.env ?? {};
        return { ...service, env };
      }),
    };
    for (const spec of [mixed, missing]) {
      // These requests reach the feature policy directly, without HTTP schema rejection.
      await expect(
        c.actuator.create({
          cogniKey: "new-app",
          environment: "production",
          identity: IDENTITY,
          spec,
        })
      ).rejects.toMatchObject({ code: "identity_conflict" });
      await expect(
        c.actuator.update({
          cogniKey: "app",
          externalName: "7002",
          environment: "production",
          identity: IDENTITY,
          spec,
        })
      ).rejects.toMatchObject({ code: "identity_conflict" });
    }
    expect(c.cursor).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
    expect(c.update).not.toHaveBeenCalled();
    expect(c.ensure).not.toHaveBeenCalled();
    expect(await ledger.read({ cogniKey: "retained" })).toEqual({
      ...fixture.before,
      state: "released",
    });
  });
  it.each([
    false,
    true,
  ])("P1 migration feature policy refuses missing/malformed%s SHA on real released history", async (legacy) => {
    const fixture = await retainedFixture(legacy);
    await closeRetained(fixture);
    const c = releaseConsumer(fixture);
    for (const expectedSourceSha of [
      undefined,
      "malformed",
      ...(legacy ? [nextSha] : []),
    ]) {
      await expect(
        c.actuator.observe({
          cogniKey: "app",
          environment: "production",
          workload: "toks9",
          ...(expectedSourceSha ? { expectedSourceSha } : {}),
          migration: {
            profile: "cogni-node-app-v1",
            bundleDigest: `sha256:${"a".repeat(64)}`,
            image: `ghcr.io/example/app@sha256:${"b".repeat(64)}`,
          },
        })
      ).rejects.toMatchObject({ code: "identity_conflict" });
    }
    expect(c.ensure).not.toHaveBeenCalled();
    expect(c.cursor).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
    expect(c.update).not.toHaveBeenCalled();
  });
  it("P1 refuses missing current custody on released SQL history", async () => {
    const fixture = await retainedFixture();
    await closeRetained(fixture);
    const c = releaseConsumer(fixture, false);
    await expect(
      c.actuator.create({
        cogniKey: "app",
        environment: "production",
        identity: IDENTITY,
        spec: c.spec(),
      })
    ).rejects.toMatchObject({
      code: "ledger_unavailable",
      message: "current database cell custody unavailable",
    });
    expect(c.cursor).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
  });
  it.each([
    "allocated",
    "released",
    "no-cell",
  ])("P1 admits legitimate current custody on %s control", async (state) => {
    const fixture = await retainedFixture();
    if (state === "released") await closeRetained(fixture);
    if (state === "no-cell")
      await db
        .delete(akashTxAllocations)
        .where(eq(akashTxAllocations.id, fixture.before.receiptId));
    fixture.custody.canonicalEndpointHost = "moved.example";
    for (const consumer of [fixture.custody.app, fixture.custody.service]) {
      const url = new URL(consumer.dsn);
      url.hostname = "moved.example";
      url.port = "32728";
      url.password = "rotated";
      consumer.dsn = url.toString();
    }
    DatabaseCellAppliedCustodySchema.parse(fixture.custody);
    const c = releaseConsumer(fixture);
    await expect(
      c.actuator.create({
        cogniKey: "app",
        environment: "production",
        identity: IDENTITY,
        spec: c.spec(),
      })
    ).resolves.toMatchObject({ externalName: "7002" });
    const changed: ProvisionSpec = {
      ...c.spec(),
      services: c
        .spec()
        .services.map((app) => ({ ...app, image: "ghcr.io/example/app:new" })),
    };
    await c.actuator.update({
      cogniKey: "app",
      externalName: "7002",
      environment: "production",
      identity: { ...IDENTITY, compositeGeneration: 4 },
      spec: changed,
    });
    await c.actuator.observe({
      cogniKey: "app",
      environment: "production",
      workload: "toks9",
      expectedSourceSha: nextSha,
      migration: {
        profile: "cogni-node-app-v1",
        bundleDigest: `sha256:${"a".repeat(64)}`,
        image: `ghcr.io/example/app@sha256:${"b".repeat(64)}`,
      },
    });
    expect(c.create).toHaveBeenCalledTimes(1);
    expect(c.update).toHaveBeenCalledTimes(1);
    expect(c.ensure).toHaveBeenCalledTimes(1);
  });
  it("P4 actual binding SQL CAS accepts active save and refuses release between read and otherwise-valid save", async () => {
    const fixture = await retainedFixture();
    const allocatedRecord = await ledger.read({ cogniKey: "retained" });
    if (!allocatedRecord) throw new Error("missing allocated read");
    const preimage = await fixture.bindingStore.read("retained");
    const changed = AppliedDatabaseCellReceiptsSchema.parse(
      preimage.map((receipt) => ({ ...receipt, targetBuildSha: nextSha }))
    );
    await fixture.bindingStore.save(allocatedRecord, changed, preimage);
    expect(await fixture.bindingStore.read("retained")).toEqual(changed);
    const selected = await ledger.read({ cogniKey: "retained" });
    if (!selected) throw new Error("missing allocated selection");
    const expected = await fixture.bindingStore.read("retained");
    const next = AppliedDatabaseCellReceiptsSchema.parse(
      expected.map((receipt) => ({
        ...receipt,
        targetBuildSha: "c".repeat(40),
      }))
    );
    // Same identity, exact current preimage, valid changed binding; only state changes.
    await ledger.markReleased({ cogniKey: "retained" });
    const [postRelease] = await db
      .select()
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.id, selected.receiptId));
    expect(postRelease?.state).toBe("released");
    expect(await fixture.bindingStore.read("retained")).toEqual(expected);
    await expect(
      fixture.bindingStore.save(selected, next, expected)
    ).rejects.toThrow(
      "cell allocation changed during binding compare-and-swap"
    );
    const [after] = await db
      .select()
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.id, selected.receiptId));
    expect(after).toEqual(postRelease);
    expect(after?.externalName).toBe("7001");
    expect(await fixture.bindingStore.read("retained")).toEqual(expected);
  });
  const replayCall = {
    cogniKey: "k1",
    environment: "candidate-a",
    identity: IDENTITY,
    spec: {
      name: "toks9",
      services: [
        {
          name: "app",
          image: "ghcr.io/example/app:fixed",
          cpuUnits: 0.5,
          memoryMi: 512,
          storageMi: 512,
          env: {},
          expose: [],
        },
      ],
    },
  };
  it("observes exact CLOSED with no leases, preserves unknown cost and replays STILL-CLOSED across restart without provider POSTs", async () => {
    const receiptId = await allocated();
    const first = composed(nativeDetail());
    await expect(
      first.actuator.observe({ cogniKey: "k1" })
    ).resolves.toMatchObject({
      found: true,
      resource: { state: "closed", externalName: "7001" },
    });
    await expect(first.ledger.read({ cogniKey: "k1" })).resolves.toMatchObject({
      receiptId,
      state: "released",
      externalName: "7001",
    });
    await expect(first.actuator.create(replayCall)).resolves.toMatchObject({
      replayed: true,
      state: "closed",
      externalName: "7001",
    });
    const restarted = composed(nativeDetail());
    await expect(restarted.actuator.create(replayCall)).resolves.toMatchObject({
      replayed: true,
      state: "closed",
      externalName: "7001",
    });
    await expect(
      restarted.actuator.observe({ cogniKey: "k1" })
    ).resolves.toMatchObject({ found: true, resource: { state: "closed" } });
    expect(first.posts).toEqual([]);
    expect(restarted.posts).toEqual([]);
    const [row] = await db.select().from(computeCostIntervals);
    expect(row).toMatchObject({
      allocationReceiptId: receiptId,
      resourceId: "7001",
      rateAmount: null,
      rateDenom: null,
      cumulativeTransferred: [],
    });
    expect(first.lines).toContainEqual(
      expect.objectContaining({
        marker: "compute_cost_unavailable",
        fields: expect.objectContaining({ accounting: "unknown" }),
      })
    );
  });
  it("keeps prior exact accounting unchanged when CLOSED has no fresh lease evidence", async () => {
    const allocationReceiptId = await allocated();
    await store.bind({ allocationReceiptId, resource: resource("7001") });
    await store.observe({ allocationReceiptId, evidence: evidence() });
    const [before] = await db.select().from(computeCostIntervals);
    const c = composed(nativeDetail());
    await expect(c.actuator.observe({ cogniKey: "k1" })).resolves.toMatchObject(
      { found: true, resource: { state: "closed" } }
    );
    const [after] = await db.select().from(computeCostIntervals);
    expect(after).toEqual(before);
    expect(
      c.lines.some((line) => line.marker === "compute_cost_observed")
    ).toBe(false);
    expect(c.lines).toContainEqual(
      expect.objectContaining({
        marker: "compute_cost_unavailable",
        fields: expect.objectContaining({ accounting: "unknown" }),
      })
    );
    expect(c.posts).toEqual([]);
  });
  it.each([
    {},
    { dseq: "7002", owner: "akash1consumer" },
    { dseq: "7001" },
    { dseq: "7001", owner: "akash1other" },
  ])("native subject %j refuses without settling the real receipt", async (id) => {
    await allocated();
    const c = composed(
      nativeDetail(false, { deployment: { id, state: "closed" } })
    );
    await expect(c.actuator.observe({ cogniKey: "k1" })).rejects.toMatchObject({
      code: "provider_rejected",
    });
    await expect(c.ledger.read({ cogniKey: "k1" })).resolves.toMatchObject({
      state: "allocated",
      externalName: "7001",
    });
    expect(c.posts).toEqual([]);
  });
  it.each([
    { dseq: "7002", owner: "akash1consumer" },
    { dseq: "7001", owner: "akash1other" },
  ])("wrong second-read native subject %j refuses before release", async (id) => {
    await allocated();
    const c = composed(
      nativeDetail(),
      nativeDetail(false, { deployment: { id, state: "closed" } })
    );
    await expect(c.actuator.observe({ cogniKey: "k1" })).rejects.toMatchObject({
      code: "ledger_unavailable",
    });
    await expect(c.ledger.read({ cogniKey: "k1" })).resolves.toMatchObject({
      state: "allocated",
    });
    expect(c.posts).toEqual([]);
  });
  it.each([
    "consumer",
    "resource",
    "another receipt",
  ])("real %s bind conflict refuses CLOSED/no-leases before release", async (conflict) => {
    const allocationReceiptId = await allocated();
    if (conflict === "another receipt") {
      const other = await allocated("k2", "7001");
      await store.bind({
        allocationReceiptId: other,
        resource: resource("7001"),
      });
    } else {
      await store.bind({
        allocationReceiptId,
        resource: resource(
          "7001",
          conflict === "consumer" ? "akash1other" : "akash1consumer"
        ),
      });
      if (conflict === "resource")
        await db
          .update(computeCostIntervals)
          .set({ resourceId: "7999" })
          .where(
            eq(computeCostIntervals.allocationReceiptId, allocationReceiptId)
          );
    }
    const c = composed(nativeDetail());
    await expect(c.actuator.observe({ cogniKey: "k1" })).rejects.toMatchObject({
      code: "ledger_unavailable",
    });
    await expect(c.ledger.read({ cogniKey: "k1" })).resolves.toMatchObject({
      state: "allocated",
    });
    expect(c.lines).toContainEqual(
      expect.objectContaining({
        marker: "compute_cost_unavailable",
        fields: expect.objectContaining({
          operation: "bind",
          causeType: "cost_invariant",
        }),
      })
    );
    expect(c.posts).toEqual([]);
  });
  it.each([
    "receipt supplier",
    "prior supplier",
    "rate",
    "transfer",
    "chronology",
  ])("real %s evidence conflict refuses before release", async (conflict) => {
    const allocationReceiptId = await allocated();
    await store.bind({ allocationReceiptId, resource: resource("7001") });
    if (conflict === "prior supplier")
      await db
        .update(akashTxAllocations)
        .set({ providerAccount: null })
        .where(eq(akashTxAllocations.id, allocationReceiptId));
    await store.observe({
      allocationReceiptId,
      evidence: evidence(
        conflict === "chronology"
          ? { observedAt: new Date("2026-09-15T00:01:00.000Z") }
          : {}
      ),
    });
    const detail = nativeDetail(true);
    if (!detail.leases[0] || !detail.escrow_account)
      throw new Error("missing full fixture");
    if (conflict.includes("supplier"))
      detail.leases[0].id.provider = "akash1other";
    if (conflict === "rate") detail.leases[0].price.amount = "8";
    if (conflict === "transfer")
      detail.escrow_account.state.transferred[0] = {
        amount: "9",
        denom: "uakt",
      };
    const c = composed(detail);
    await expect(c.actuator.observe({ cogniKey: "k1" })).rejects.toMatchObject({
      code: "ledger_unavailable",
    });
    await expect(c.ledger.read({ cogniKey: "k1" })).resolves.toMatchObject({
      state: "allocated",
    });
    expect(c.lines).toContainEqual(
      expect.objectContaining({ marker: "compute_cost_unavailable" })
    );
    expect(c.posts).toEqual([]);
  });
  it("records exact full native CLOSED accounting before settlement", async () => {
    const allocationReceiptId = await allocated();
    const c = composed(nativeDetail(true));
    await expect(c.actuator.observe({ cogniKey: "k1" })).resolves.toMatchObject(
      { found: true, resource: { state: "closed", externalName: "7001" } }
    );
    await expect(c.ledger.read({ cogniKey: "k1" })).resolves.toMatchObject({
      state: "released",
      receiptId: allocationReceiptId,
    });
    const [row] = await db.select().from(computeCostIntervals);
    expect(row).toMatchObject({
      allocationReceiptId,
      state: "closed",
      rateAmount: "7.5",
      rateDenom: "uakt",
      providerSupplierAccountId: "akash1provider",
      cumulativeTransferred: [{ amount: "19.25", denom: "uakt" }],
      providerClosedAtPosition: "150",
    });
    expect(c.posts).toEqual([]);
  });
});
