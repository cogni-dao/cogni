// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-actuator.test`
 * Purpose: Prove the behaviours that make this actuator irreplaceable by generic OSS —
 *   wallet-global serialization, the pre-transaction receipt, post-response-loss recovery,
 *   observable refusal, the migration-before-transaction precondition (bug.5140), and the
 *   authoritative binding of every paid mutation to the node that consumed it (task.5103) —
 *   the absence of any reconciliation (one transaction per call), and the composition root
 *   actually WIRING the prover that precondition depends on (story.5016).
 * Scope: Unit tests over fakes, plus one source-level probe of the composition root. Does NOT
 *   touch the Akash Console, a wallet, a Kubernetes API, or a database.
 * Invariants: no real provider IO; every "lost response" is simulated by a fake that has
 *   already allocated before it throws.
 * Side-effects: none
 * Links: ./akash-tx-actuator, @bootstrap/akash-tx-actuator, @ports/akash-tx.port, task.5095,
 *   task.5103, story.5016
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { ProvisionOutput, ProvisionSpec } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import type {
  AkashTxAllocationLedgerPort,
  AkashTxAllocationRecord,
  AkashTxConsolePort,
  AkashTxMigrationPort,
  AkashTxMigrationRequirement,
  AkashTxWorkloadIdentity,
  ComputeCostEvidencePort,
  ComputeCostStorePort,
  ComputeResourceCostEvidence,
  ComputeWorkloadMigrationInput,
} from "@/ports";
import { AkashTxError } from "@/ports";

import { AkashTxActuator, type AkashTxLogger } from "./akash-tx-actuator";

const SPEC: ProvisionSpec = {
  name: "toks9",
  services: [
    {
      name: "app",
      image: "ghcr.io/cogni-dao/toks9:sha-abc",
      cpuUnits: 0.5,
      memoryMi: 512,
      storageMi: 1024,
      expose: [{ port: 3000, as: 80, global: true }],
    },
  ],
};

/** WHO consumed — stated by the Composition on every mutating call, never derived. */
const IDENTITY: AkashTxWorkloadIdentity = {
  nodeId: "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60",
  compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
  compositeGeneration: 3,
};

/** A DIFFERENT node asking to spend under the same idempotency key. */
const OTHER_IDENTITY: AkashTxWorkloadIdentity = {
  ...IDENTITY,
  nodeId: "9a1b2c3d-4e5f-4061-8273-8495a6b7c8d9",
};

const OTHER_COMPOSITE_IDENTITY: AkashTxWorkloadIdentity = {
  ...IDENTITY,
  compositeUid: "4d3c2b1a-9876-4321-baaa-010203040506",
};

/** The precondition every mutating call must state (bug.5140). */
const REQUIRE: Extract<
  AkashTxMigrationRequirement,
  { policy: "RequireBeforeTransaction" }
> = {
  policy: "RequireBeforeTransaction",
  profile: "cogni-node-app-v1",
  bundleDigest: `sha256:${"a".repeat(64)}`,
  image: `ghcr.io/cogni-dao/toks9@sha256:${"b".repeat(64)}`,
  doltgres: true,
};

/** Per-digest migration prover. Defaults to an already-migrated digest. */
class FakeMigration implements AkashTxMigrationPort {
  calls: ComputeWorkloadMigrationInput[] = [];
  outcome: "succeeded" | "running" | "failed" = "succeeded";
  throws?: Error;

  async ensure(input: ComputeWorkloadMigrationInput) {
    this.calls.push(input);
    if (this.throws) throw this.throws;
    return this.outcome;
  }
}

/** Console error shape the adapter publishes (name + code); mapped structurally. */
function consoleError(code: string, httpStatus?: number): Error {
  const error = new Error(`console failure ${code}`);
  error.name = "AkashComputeError";
  Object.assign(error, { code, httpStatus });
  return error;
}

/** In-memory ledger with the SAME invariants the partial unique index enforces. */
class FakeLedger implements AkashTxAllocationLedgerPort {
  readonly rows = new Map<string, AkashTxAllocationRecord>();
  failReads = false;

  async claim(input: {
    cogniKey: string;
    workload: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
  }) {
    if (this.failReads) throw new Error("ledger down");
    const existing = this.rows.get(input.cogniKey);
    if (existing) {
      return existing.state === "preparing"
        ? ({ state: "owned", record: existing } as const)
        : ({ state: "settled", record: existing } as const);
    }
    const holder = [...this.rows.values()].find((r) => r.state === "preparing");
    if (holder) {
      return { state: "blocked", ownerCogniKey: holder.cogniKey } as const;
    }
    const record: AkashTxAllocationRecord = {
      receiptId: `receipt-${input.cogniKey}`,
      cogniKey: input.cogniKey,
      identity: input.identity,
      environment: input.environment,
      state: "preparing",
    };
    this.rows.set(input.cogniKey, record);
    return { state: "claimed", record } as const;
  }

  async bindIdentity(input: {
    cogniKey: string;
    environment: string;
    identity: AkashTxWorkloadIdentity;
  }) {
    if (this.failReads) throw new Error("ledger down");
    const row = this.rows.get(input.cogniKey);
    if (!row) return { state: "absent" } as const;
    if (
      row.identity.nodeId !== input.identity.nodeId ||
      row.environment !== input.environment ||
      row.identity.compositeUid !== input.identity.compositeUid
    ) {
      return { state: "conflict", record: row } as const;
    }
    const record: AkashTxAllocationRecord = {
      ...row,
      identity: {
        ...row.identity,
        compositeGeneration: Math.max(
          row.identity.compositeGeneration,
          input.identity.compositeGeneration
        ),
      },
    };
    this.rows.set(input.cogniKey, record);
    return { state: "bound", record } as const;
  }

  async prepare(input: { cogniKey: string; allocationCursor: string }) {
    const row = this.rows.get(input.cogniKey);
    if (!row || row.state !== "preparing") {
      throw new Error("no preparing slot");
    }
    this.rows.set(input.cogniKey, {
      ...row,
      allocationCursor: input.allocationCursor,
    });
  }

  async recordAllocation(input: {
    cogniKey: string;
    externalName: string;
    providerAccount?: string;
  }) {
    const row = this.rows.get(input.cogniKey);
    if (!row) throw new Error("unknown key");
    this.rows.set(input.cogniKey, {
      ...row,
      state: "allocated",
      externalName: row.externalName ?? input.externalName,
      ...(input.providerAccount
        ? { providerAccount: row.providerAccount ?? input.providerAccount }
        : {}),
    });
  }

  async fail(input: { cogniKey: string; failureCode: string }) {
    const row = this.rows.get(input.cogniKey);
    if (row?.state === "preparing" && !row.externalName) {
      this.rows.set(input.cogniKey, { ...row, state: "failed" });
    }
  }

  async markReleased(input: { cogniKey: string }) {
    const row = this.rows.get(input.cogniKey);
    if (row) this.rows.set(input.cogniKey, { ...row, state: "released" });
  }

  async read(input: { cogniKey: string }) {
    if (this.failReads) throw new Error("ledger down");
    return this.rows.get(input.cogniKey) ?? null;
  }
}

function seedAllocated(
  ledger: FakeLedger,
  cogniKey = "k1",
  externalName = "7001"
): void {
  ledger.rows.set(cogniKey, {
    receiptId: `receipt-${cogniKey}`,
    cogniKey,
    identity: IDENTITY,
    environment: "candidate-a",
    state: "allocated",
    externalName,
    providerAccount: "akash1provider",
  });
}

const COST_EVIDENCE: ComputeResourceCostEvidence = {
  computeProvider: "akash",
  resourceId: "7001",
  providerConsumerAccountId: "akash1consumer",
  providerSupplierAccountId: "akash1provider",
  rate: { amount: "7.5", denom: "uakt", unit: "block" },
  providerOpenedAtPosition: "100",
  escrow: {
    state: "open",
    funds: [{ amount: "500000", denom: "uakt" }],
    transferred: [{ amount: "10", denom: "uakt" }],
  },
  observedAt: new Date("2026-09-15T00:00:00.000Z"),
};

class FakeCost implements ComputeCostEvidencePort, ComputeCostStorePort {
  binds: {
    allocationReceiptId: string;
    providerConsumerAccountId: string;
    resourceId: string;
  }[] = [];
  observations: { allocationReceiptId: string; resourceId: string }[] = [];
  closes: string[] = [];
  failBind = false;
  failEvidence = false;
  failObserve = false;
  failClose = false;
  failureMessage = "cost dependency down";

  async observeCost(input: { resourceId: string }) {
    if (this.failEvidence) throw new Error(this.failureMessage);
    return { ...COST_EVIDENCE, resourceId: input.resourceId };
  }

  async bind(input: {
    allocationReceiptId: string;
    resource: {
      computeProvider: string;
      providerConsumerAccountId: string;
      resourceId: string;
    };
  }) {
    if (this.failBind) throw new Error(this.failureMessage);
    this.binds.push({
      allocationReceiptId: input.allocationReceiptId,
      providerConsumerAccountId: input.resource.providerConsumerAccountId,
      resourceId: input.resource.resourceId,
    });
  }

  async observe(input: {
    allocationReceiptId: string;
    evidence: ComputeResourceCostEvidence;
  }) {
    if (this.failObserve) throw new Error(this.failureMessage);
    this.observations.push({
      allocationReceiptId: input.allocationReceiptId,
      resourceId: input.evidence.resourceId,
    });
  }

  async close(input: { allocationReceiptId: string }) {
    if (this.failClose) throw new Error(this.failureMessage);
    this.closes.push(input.allocationReceiptId);
  }

  async reportByNode() {
    return [];
  }

  async reportByNodeIds(_nodeIds: readonly string[]) {
    return [];
  }
}

function costDeps(cost = new FakeCost()) {
  return {
    cost,
    costEvidence: cost,
    costStore: cost,
    providerConsumerAccountId: "akash1consumer",
  };
}

interface FakeConsoleOptions {
  cursor?: string;
  /** Simulate a lost response: the lease IS created, then the call throws. */
  loseResponseAfterAllocation?: boolean;
  allocateError?: Error;
  recovered?: ProvisionOutput | null;
  recoverError?: Error;
}

class FakeConsole implements AkashTxConsolePort {
  cursorCalls = 0;
  allocateCalls = 0;
  recoverCalls = 0;
  statusCalls = 0;
  updateCalls = 0;
  releaseCalls: string[] = [];
  nextLeaseId = "7001";

  constructor(private readonly options: FakeConsoleOptions = {}) {}

  async allocationCursor(): Promise<string> {
    this.cursorCalls += 1;
    return this.options.cursor ?? "7000";
  }

  async allocateAndLease(input: {
    spec: ProvisionSpec;
    onAllocated?: (leaseId: string) => Promise<void>;
  }): Promise<{ leaseId: string; providerAccount: string }> {
    this.allocateCalls += 1;
    if (this.options.allocateError) throw this.options.allocateError;
    if (this.options.loseResponseAfterAllocation) {
      // The transaction succeeded on-chain; only the response was lost, so the
      // caller never learns the handle and the ledger never gets it either.
      throw consoleError("TIMEOUT");
    }
    await input.onAllocated?.(this.nextLeaseId);
    return { leaseId: this.nextLeaseId, providerAccount: "akash1provider" };
  }

  async findAllocationSince(cursor: string): Promise<ProvisionOutput | null> {
    this.recoverCalls += 1;
    void cursor;
    if (this.options.recoverError) throw this.options.recoverError;
    return this.options.recovered ?? null;
  }

  async status(input: { leaseId: string }): Promise<ProvisionOutput> {
    this.statusCalls += 1;
    return {
      provider: "akash",
      leaseId: input.leaseId,
      state: "active",
      endpoints: [`https://${input.leaseId}.example.net`],
    };
  }

  async updateAllocated(): Promise<void> {
    this.updateCalls += 1;
  }

  async release(input: { leaseId: string }): Promise<void> {
    this.releaseCalls.push(input.leaseId);
  }
}

function recordingLogger(): AkashTxLogger & {
  lines: { level: string; marker: string; fields: Record<string, unknown> }[];
} {
  const lines: {
    level: string;
    marker: string;
    fields: Record<string, unknown>;
  }[] = [];
  return {
    lines,
    info: (fields, marker) => lines.push({ level: "info", marker, fields }),
    warn: (fields, marker) => lines.push({ level: "warn", marker, fields }),
    error: (fields, marker) => lines.push({ level: "error", marker, fields }),
  };
}

function build(consoleOptions: FakeConsoleOptions = {}) {
  const ledger = new FakeLedger();
  const api = new FakeConsole(consoleOptions);
  const log = recordingLogger();
  const migration = new FakeMigration();
  const costs = costDeps();
  const actuator = new AkashTxActuator({
    console: api,
    ledger,
    log,
    migration,
    costEvidence: costs.costEvidence,
    costStore: costs.costStore,
    providerConsumerAccountId: costs.providerConsumerAccountId,
  });
  return { actuator, ledger, api, log, migration, cost: costs.cost };
}

describe("AkashTxActuator.create", () => {
  it("writes the pre-transaction cursor BEFORE the Console transaction", async () => {
    const { actuator, ledger, api } = build();
    const order: string[] = [];
    const originalPrepare = ledger.prepare.bind(ledger);
    ledger.prepare = async (input) => {
      order.push("prepare");
      await originalPrepare(input);
    };
    const originalAllocate = api.allocateAndLease.bind(api);
    api.allocateAndLease = async (input) => {
      order.push("allocate");
      return originalAllocate(input);
    };

    const result = await actuator.create({
      cogniKey: "candidate-a/toks9/1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });

    expect(order).toEqual(["prepare", "allocate"]);
    expect(result.externalName).toBe("7001");
    expect(result.replayed).toBe(false);
    expect(result.recovered).toBe(false);
    expect(ledger.rows.get("candidate-a/toks9/1")).toMatchObject({
      state: "allocated",
      externalName: "7001",
      allocationCursor: "7000",
    });
  });

  it("performs exactly one provider transaction per call", async () => {
    const { actuator, api } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    expect(api.allocateCalls).toBe(1);
    expect(api.cursorCalls).toBe(1);
  });

  it("recovers exactly one paid lease after a lost response, without re-spending", async () => {
    const { actuator, ledger, api, log } = build({
      loseResponseAfterAllocation: true,
      recovered: {
        provider: "akash",
        leaseId: "7042",
        state: "pending",
        endpoints: [],
      },
    });

    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    // The durable receipt survives the crash: cursor present, no handle, slot still held.
    expect(ledger.rows.get("k1")).toMatchObject({
      state: "preparing",
      allocationCursor: "7000",
    });
    expect(
      log.lines.some((l) => l.marker === "akash_tx_allocation_outcome_unknown")
    ).toBe(true);

    const retried = await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });

    expect(retried.recovered).toBe(true);
    expect(retried.externalName).toBe("7042");
    // The second call adopted the existing lease: no second transaction was attempted.
    expect(api.allocateCalls).toBe(1);
    expect(api.recoverCalls).toBe(1);
    expect(ledger.rows.get("k1")).toMatchObject({
      state: "allocated",
      externalName: "7042",
    });
    expect(
      log.lines.some((l) => l.marker === "akash_tx_allocation_recovered")
    ).toBe(true);
  });

  it("fails closed when recovery finds no allocation, and keeps holding the wallet slot", async () => {
    const { actuator, ledger, api, log } = build({
      loseResponseAfterAllocation: true,
      recovered: null,
    });
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "outcome_unknown" });

    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "allocation_unresolved" });

    expect(api.allocateCalls).toBe(1);
    expect(ledger.rows.get("k1")?.state).toBe("preparing");
    expect(
      log.lines.some((l) => l.marker === "akash_tx_allocation_unresolved")
    ).toBe(true);
  });

  it("fails closed when more than one post-baseline allocation exists", async () => {
    const { actuator, api } = build({
      loseResponseAfterAllocation: true,
      recoverError: consoleError("AMBIGUOUS_ADOPTION"),
    });
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "allocation_ambiguous" });
    expect(api.allocateCalls).toBe(1);
  });

  it("serializes the wallet: a second key is refused while one allocation is uncertain", async () => {
    const { actuator, api, log } = build({
      loseResponseAfterAllocation: true,
      recovered: null,
    });
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "outcome_unknown" });

    const blocked = await actuator
      .create({
        cogniKey: "k2",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
      .catch((error: unknown) => error);

    expect(blocked).toBeInstanceOf(AkashTxError);
    expect(blocked).toMatchObject({
      code: "wallet_allocation_blocked",
      ownerCogniKey: "k1",
    });
    // bug.5115: the refusal MUST be visible in logs, not only in the response.
    const line = log.lines.find(
      (l) => l.marker === "akash_tx_wallet_allocation_blocked"
    );
    expect(line?.level).toBe("warn");
    expect(line?.fields).toMatchObject({ cogniKey: "k2", ownerCogniKey: "k1" });
    // Nothing was spent for k2.
    expect(api.allocateCalls).toBe(1);
  });

  it("releases the wallet slot as soon as the handle is durable", async () => {
    const { actuator, ledger } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    expect(ledger.rows.get("k1")?.state).toBe("allocated");

    const second = await actuator.create({
      cogniKey: "k2",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    expect(second.externalName).toBe("7001");
  });

  it("replays a settled key without spending again", async () => {
    const { actuator, api, log } = build();
    const first = await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    const replay = await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    expect(replay.externalName).toBe(first.externalName);
    expect(replay.replayed).toBe(true);
    expect(api.allocateCalls).toBe(1);
    expect(log.lines.some((l) => l.marker === "akash_tx_create_replayed")).toBe(
      true
    );
  });

  it("refuses to spend when the durable ledger is unavailable", async () => {
    const { actuator, ledger, api } = build();
    ledger.failReads = true;
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "ledger_unavailable" });
    expect(api.cursorCalls).toBe(0);
    expect(api.allocateCalls).toBe(0);
  });

  it("maps a screening rejection to a terminal provider_rejected", async () => {
    const { actuator } = build({
      allocateError: consoleError("NO_ELIGIBLE_BIDS"),
    });
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "provider_rejected" });
  });
});

describe("AkashTxActuator.observe", () => {
  it("reads a known handle only after matching it to the durable receipt", async () => {
    const { actuator, api, ledger } = build();
    seedAllocated(ledger);
    const observation = await actuator.observe({
      cogniKey: "k1",
      externalName: "7001",
    });
    expect(observation.found).toBe(true);
    expect(observation.resource).toMatchObject({
      externalName: "7001",
      state: "active",
    });
    expect(api.recoverCalls).toBe(0);
  });

  it("reports not-found for an unknown key so the caller may create", async () => {
    const { actuator } = build();
    expect(await actuator.observe({ cogniKey: "unknown" })).toEqual({
      found: false,
    });
  });

  it("resolves an uncertain allocation from the durable receipt alone", async () => {
    const { actuator, api } = build({
      loseResponseAfterAllocation: true,
      recovered: {
        provider: "akash",
        leaseId: "7042",
        state: "active",
        endpoints: ["https://7042.example.net"],
      },
    });
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "outcome_unknown" });

    const observation = await actuator.observe({ cogniKey: "k1" });
    expect(observation).toMatchObject({
      found: true,
      recovered: true,
      resource: { externalName: "7042" },
    });
    expect(api.allocateCalls).toBe(1);
  });

  it("reports a single bounded serving probe when asked", async () => {
    const ledger = new FakeLedger();
    const api = new FakeConsole();
    let probes = 0;
    const actuator = new AkashTxActuator({
      console: api,
      ledger,
      log: recordingLogger(),
      ...costDeps(),
      probe: async () => {
        probes += 1;
        return true;
      },
    });
    seedAllocated(ledger);
    const observation = await actuator.observe({
      cogniKey: "k1",
      externalName: "7001",
      expectedSourceSha: "a".repeat(40),
    });
    expect(observation.serving).toBe(true);
    expect(probes).toBe(1);
  });

  it("never probes when no expected sha is supplied", async () => {
    const ledger = new FakeLedger();
    const api = new FakeConsole();
    let probes = 0;
    const actuator = new AkashTxActuator({
      console: api,
      ledger,
      log: recordingLogger(),
      ...costDeps(),
      probe: async () => {
        probes += 1;
        return true;
      },
    });
    seedAllocated(ledger);
    const observation = await actuator.observe({
      cogniKey: "k1",
      externalName: "7001",
    });
    expect(observation.serving).toBeUndefined();
    expect(probes).toBe(0);
  });
});

describe("AkashTxActuator.update / delete", () => {
  it("updates in place without opening a new allocation", async () => {
    const { actuator, api, ledger } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    const spent = { cursor: api.cursorCalls, allocate: api.allocateCalls };

    const resource = await actuator.update({
      cogniKey: "k1",
      externalName: "7001",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });

    expect(resource.externalName).toBe("7001");
    expect(api.updateCalls).toBe(1);
    // No new wallet slot, no cursor, no transaction — an SDL replacement mints nothing.
    expect(api.cursorCalls).toBe(spent.cursor);
    expect(api.allocateCalls).toBe(spent.allocate);
    // And no second receipt: the identity re-bind lands on the SAME row the create opened.
    expect(ledger.rows.size).toBe(1);
  });

  it("releases the provider resource and settles the key", async () => {
    const { actuator, api, ledger } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    await actuator.delete({ cogniKey: "k1", externalName: "7001" });
    expect(api.releaseCalls).toEqual(["7001"]);
    expect(ledger.rows.get("k1")?.state).toBe("released");
  });

  it("treats deleting an already-gone resource as success", async () => {
    const ledger = new FakeLedger();
    const api = new FakeConsole();
    api.release = async () => {
      throw consoleError("HTTP_ERROR", 404);
    };
    const actuator = new AkashTxActuator({
      console: api,
      ledger,
      log: recordingLogger(),
      ...costDeps(),
    });
    seedAllocated(ledger);
    await expect(
      actuator.delete({ cogniKey: "k1", externalName: "7001" })
    ).resolves.toBeUndefined();
  });

  it("refuses a mismatched update handle before provider IO", async () => {
    const { actuator, api } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    await expect(
      actuator.update({
        cogniKey: "k1",
        externalName: "7999",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "identity_conflict" });
    expect(api.updateCalls).toBe(0);
  });

  it("refuses a mismatched delete handle before provider IO", async () => {
    const { actuator, api } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    await expect(
      actuator.delete({ cogniKey: "k1", externalName: "7999" })
    ).rejects.toMatchObject({ code: "identity_conflict" });
    expect(api.releaseCalls).toEqual([]);
  });

  it("retries cost close after provider release without creating another lease", async () => {
    const { actuator, api, ledger, cost } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    cost.failClose = true;
    await expect(
      actuator.delete({ cogniKey: "k1", externalName: "7001" })
    ).rejects.toMatchObject({ code: "ledger_unavailable" });
    expect(ledger.rows.get("k1")?.state).toBe("released");
    expect(api.allocateCalls).toBe(1);

    cost.failClose = false;
    api.release = async () => {
      throw consoleError("HTTP_ERROR", 404);
    };
    await expect(
      actuator.delete({ cogniKey: "k1", externalName: "7001" })
    ).resolves.toBeUndefined();
    expect(api.allocateCalls).toBe(1);
    expect(cost.closes).toEqual(["receipt-k1"]);
  });
});

describe("AkashTxActuator cost attribution (task.5071)", () => {
  it("binds and observes the paid handle against the allocation receipt", async () => {
    const { actuator, cost } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    expect(cost.binds).toContainEqual({
      allocationReceiptId: "receipt-k1",
      providerConsumerAccountId: "akash1consumer",
      resourceId: "7001",
    });
    expect(cost.observations).toContainEqual({
      allocationReceiptId: "receipt-k1",
      resourceId: "7001",
    });
  });

  it("holds acceptance on a cost failure and repairs by replay without re-spending", async () => {
    const { actuator, api, ledger, cost, log } = build();
    cost.failureMessage = "secret-like-provider-body";
    cost.failBind = true;
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "ledger_unavailable" });
    expect(api.allocateCalls).toBe(1);
    expect(api.releaseCalls).toEqual([]);
    expect(ledger.rows.get("k1")).toMatchObject({
      state: "allocated",
      externalName: "7001",
    });

    cost.failBind = false;
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).resolves.toMatchObject({ externalName: "7001", replayed: true });
    expect(api.allocateCalls).toBe(1);
    expect(log.lines.map((line) => line.marker)).toContain(
      "compute_cost_unavailable"
    );
    expect(JSON.stringify(log.lines)).not.toContain(
      "secret-like-provider-body"
    );
  });
});

describe("AkashTxActuator migration gate (bug.5140)", () => {
  it("never mints a paid lease while the digest migration is still running", async () => {
    // THE outcome bug.5140 is about: a workload whose migration is pending stays leaseless.
    const { actuator, api, ledger, migration, log } = build();
    migration.outcome = "running";

    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "migration_pending" });

    // No transaction, no cursor read - and, critically, no wallet slot taken: a migration runs
    // for minutes, and holding the wallet-global slot across it would deadlock the fleet.
    expect(api.allocateCalls).toBe(0);
    expect(api.cursorCalls).toBe(0);
    expect(ledger.rows.size).toBe(0);
    // bug.5115: the refusal is a log line first, a response second.
    expect(log.lines.map((line) => line.marker)).toContain(
      "akash_tx_migration_pending"
    );
  });

  it("proves the migration BEFORE it claims the wallet slot", async () => {
    const { actuator, ledger, migration } = build();
    const order: string[] = [];
    const ensure = migration.ensure.bind(migration);
    migration.ensure = async (input) => {
      order.push("migrate");
      return ensure(input);
    };
    const claim = ledger.claim.bind(ledger);
    ledger.claim = async (input) => {
      order.push("claim");
      return claim(input);
    };

    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });

    expect(order).toEqual(["migrate", "claim"]);
  });

  it("refuses terminally when the migration itself failed", async () => {
    const { actuator, api, migration } = build();
    migration.outcome = "failed";

    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "migration_failed" });
    expect(api.allocateCalls).toBe(0);
  });

  it("refuses to spend when it cannot prove the migration at all", async () => {
    const ledger = new FakeLedger();
    const api = new FakeConsole();
    const log = recordingLogger();
    // An actuator wired WITHOUT a prover: fail closed, never assume migrated.
    const actuator = new AkashTxActuator({
      console: api,
      ledger,
      log,
      ...costDeps(),
    });

    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "migration_unavailable" });
    expect(api.allocateCalls).toBe(0);
    expect(log.lines.map((line) => line.marker)).toContain(
      "akash_tx_migration_capability_missing"
    );
  });

  it("leases a workload whose digest is already migrated", async () => {
    const { actuator, api, migration } = build();

    const result = await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });

    expect(result.externalName).toBe("7001");
    expect(api.allocateCalls).toBe(1);
    expect(migration.calls[0]).toMatchObject({
      nodeSlug: "toks9",
      bundleDigest: REQUIRE.bundleDigest,
    });
  });

  it("leases a database-free workload that explicitly declares Skip", async () => {
    const { actuator, api, migration } = build();

    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: { policy: "Skip" },
    });

    expect(api.allocateCalls).toBe(1);
    expect(migration.calls).toHaveLength(0);
  });

  it("gates the SDL update too - a new digest never meets an unmigrated database", async () => {
    const { actuator, api, migration } = build();
    migration.outcome = "running";

    await expect(
      actuator.update({
        cogniKey: "k1",
        externalName: "7001",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "migration_pending" });
    expect(api.updateCalls).toBe(0);
  });

  it("leaves observe and delete ungated - neither spends, and delete must always work", async () => {
    const { actuator, api, migration } = build();
    migration.outcome = "failed";

    await expect(actuator.observe({ cogniKey: "k1" })).resolves.toMatchObject({
      found: false,
    });
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: { policy: "Skip" },
    });
    await actuator.delete({ cogniKey: "k1", externalName: "7001" });
    expect(api.releaseCalls).toEqual(["7001"]);
  });
});

describe("AkashTxActuator identity binding (task.5103)", () => {
  it("makes the receipt name the consuming node BEFORE it reads a cursor or spends", async () => {
    // THE outcome task.5103 is about: identity is durable strictly before provider contact,
    // so there is no window in which a paid lease exists that nothing can attribute.
    const order: string[] = [];
    const { actuator, ledger, api, log } = build();
    const claim = ledger.claim.bind(ledger);
    ledger.claim = async (input) => {
      order.push("receipt");
      return claim(input);
    };
    const cursor = api.allocationCursor.bind(api);
    api.allocationCursor = async () => {
      order.push("cursor");
      return cursor();
    };
    const allocate = api.allocateAndLease.bind(api);
    api.allocateAndLease = async (input) => {
      order.push("allocate");
      return allocate(input);
    };

    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });

    expect(order).toEqual(["receipt", "cursor", "allocate"]);
    expect(api.allocateCalls).toBe(1);
    const row = ledger.rows.get("k1");
    expect(row?.identity).toEqual(IDENTITY);
    expect(row?.environment).toBe("candidate-a");
    // bug.5115: the binding is observable, not just persisted.
    expect(log.lines.map((line) => line.marker)).toContain(
      "akash_tx_receipt_bound"
    );
  });

  it("refuses to spend under a key whose receipt binds a different node", async () => {
    const { actuator, api, ledger, log } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    const spent = api.allocateCalls;

    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        identity: OTHER_IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "identity_conflict" });

    // Nothing spent, and the receipt still names the node that actually consumed.
    expect(api.allocateCalls).toBe(spent);
    expect(ledger.rows.get("k1")?.identity.nodeId).toBe(IDENTITY.nodeId);
    const conflict = log.lines.find(
      (line) => line.marker === "akash_tx_identity_conflict"
    );
    expect(conflict?.fields).toMatchObject({
      nodeId: OTHER_IDENTITY.nodeId,
      boundNodeId: IDENTITY.nodeId,
      operation: "create",
    });
  });

  it("refuses an SDL update from another composite before provider IO", async () => {
    const { actuator, api } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    await expect(
      actuator.update({
        cogniKey: "k1",
        externalName: "7001",
        environment: "candidate-a",
        identity: OTHER_COMPOSITE_IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "identity_conflict" });
    expect(api.updateCalls).toBe(0);
  });

  it("re-binds and records cost evidence before an SDL replacement", async () => {
    const { actuator, api, ledger, log, cost } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    const order: string[] = [];
    const bind = ledger.bindIdentity.bind(ledger);
    ledger.bindIdentity = async (input) => {
      order.push("rebind");
      return bind(input);
    };
    const observeEvidence = cost.observeCost.bind(cost);
    cost.observeCost = async (input) => {
      order.push("cost_evidence");
      return observeEvidence(input);
    };
    const observeStore = cost.observe.bind(cost);
    cost.observe = async (input) => {
      order.push("cost_store");
      return observeStore(input);
    };
    const update = api.updateAllocated.bind(api);
    api.updateAllocated = async () => {
      order.push("update");
      return update();
    };

    await actuator.update({
      cogniKey: "k1",
      externalName: "7001",
      environment: "candidate-a",
      identity: { ...IDENTITY, compositeGeneration: 9 },
      spec: SPEC,
      migration: REQUIRE,
    });

    expect(order).toEqual([
      "rebind",
      "cost_evidence",
      "cost_store",
      "update",
      "cost_evidence",
      "cost_store",
    ]);
    expect(ledger.rows.get("k1")?.identity.compositeGeneration).toBe(9);
    // IDENTITY_IS_WRITE_ONCE — an update advances the revision, never the owner.
    expect(ledger.rows.get("k1")?.identity.nodeId).toBe(IDENTITY.nodeId);
    expect(log.lines.map((line) => line.marker)).toContain(
      "akash_tx_receipt_rebound"
    );
  });

  it.each([
    "evidence",
    "store",
  ] as const)("holds an update before provider IO when pre-update cost %s fails", async (failure) => {
    const { actuator, api, ledger, cost } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });
    const before = ledger.rows.get("k1");
    const spent = { cursor: api.cursorCalls, allocate: api.allocateCalls };
    if (failure === "evidence") cost.failEvidence = true;
    else cost.failObserve = true;

    await expect(
      actuator.update({
        cogniKey: "k1",
        externalName: "7001",
        environment: "candidate-a",
        identity: { ...IDENTITY, compositeGeneration: 9 },
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "ledger_unavailable" });

    expect(api.updateCalls).toBe(0);
    expect(api.cursorCalls).toBe(spent.cursor);
    expect(api.allocateCalls).toBe(spent.allocate);
    expect(api.releaseCalls).toEqual([]);
    expect(ledger.rows.size).toBe(1);
    expect(ledger.rows.get("k1")).toMatchObject({
      receiptId: before?.receiptId,
      externalName: before?.externalName,
      state: "allocated",
    });
  });

  it("refuses an update on a paid handle that no receipt attributes", async () => {
    const { actuator, api, log } = build();

    await expect(
      actuator.update({
        cogniKey: "orphan",
        externalName: "7001",
        environment: "candidate-a",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "identity_conflict" });

    expect(api.updateCalls).toBe(0);
    expect(log.lines.map((line) => line.marker)).toContain(
      "akash_tx_receipt_absent"
    );
  });

  it("refuses an update whose receipt belongs to another environment", async () => {
    const { actuator, api } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      identity: IDENTITY,
      spec: SPEC,
      migration: REQUIRE,
    });

    await expect(
      actuator.update({
        cogniKey: "k1",
        externalName: "7001",
        environment: "production",
        identity: IDENTITY,
        spec: SPEC,
        migration: REQUIRE,
      })
    ).rejects.toMatchObject({ code: "identity_conflict" });
    expect(api.updateCalls).toBe(0);
  });
});

/**
 * The migration gate is fail-CLOSED, so an actuator constructed WITHOUT a prover refuses every
 * `RequireBeforeTransaction` mutation with `migration_unavailable` — and since the Composition
 * lowers that policy on every create/update of a `cogni-node-app-v1` workload, that is EVERY
 * paid create. story.5016: the composition root shipped in exactly that shape, and nothing
 * noticed because no XComputeWorkload had ever existed to be refused.
 *
 * Asserted at the SOURCE level on purpose, mirroring akash-tx-wallet.test.ts. The composition
 * root is a top-level-await process entrypoint — importing it reads projected secret files,
 * opens a Postgres pool and calls the live Akash Console — so there is no runtime handle to
 * inspect. `migration` is also an OPTIONAL dep, so omitting it type-checks cleanly; only a
 * test that reads the wiring can catch this class of regression.
 */
describe("composition root wiring (story.5016)", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "..", "..", "bootstrap", "akash-tx-actuator.ts"),
    "utf8"
  );

  /** The `new AkashTxActuator({ ... })` argument literal, brace-balanced. */
  function actuatorDepsLiteral(): string {
    const start = source.indexOf("new AkashTxActuator({");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = source.indexOf("{", start); i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return expect.unreachable("unbalanced AkashTxActuator deps literal");
  }

  it("wires a migration prover — a fail-closed gate with none refuses every paid create", () => {
    expect(actuatorDepsLiteral()).toMatch(/\bmigration\s*[,:]/);
  });

  it("wires receipt-linked cost evidence and storage as required actuator dependencies", () => {
    const deps = actuatorDepsLiteral();
    expect(deps).toMatch(/\bcostEvidence\s*:/);
    expect(deps).toMatch(/\bcostStore\s*:/);
    expect(deps).toMatch(
      /\bproviderConsumerAccountId\s*:\s*wallet\.expectedAccountId/
    );
    expect(source).toMatch(/new DrizzleComputeCostStore\(getDb\)/);
  });

  it("uses the SAME per-digest Job prover the ComputeWorkload controller uses", () => {
    // Not a second abstraction: the per-digest Job IS the durable proof, and two provers
    // would mean two answers for one bundle digest.
    expect(source).toMatch(/new KubernetesMigrationJobAdapter\(/);
  });
});
