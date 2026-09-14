// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-actuator.test`
 * Purpose: Prove the four behaviours that make this actuator irreplaceable by generic OSS —
 *   wallet-global serialization, the pre-transaction receipt, post-response-loss recovery, and
 *   observable refusal — plus the absence of any reconciliation (one transaction per call).
 * Scope: Unit tests over fakes. Does NOT touch the Akash Console, a wallet, or a database.
 * Invariants: no real provider IO; every "lost response" is simulated by a fake that has
 *   already allocated before it throws.
 * Side-effects: none
 * Links: ./akash-tx-actuator, @ports/akash-tx.port, task.5095
 * @internal
 */

import type { ProvisionOutput, ProvisionSpec } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import type {
  AkashTxAllocationLedgerPort,
  AkashTxAllocationRecord,
  AkashTxConsolePort,
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
      cogniKey: input.cogniKey,
      state: "preparing",
    };
    this.rows.set(input.cogniKey, record);
    return { state: "claimed", record } as const;
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
  const actuator = new AkashTxActuator({ console: api, ledger, log });
  return { actuator, ledger, api, log };
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
      spec: SPEC,
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
      spec: SPEC,
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
        spec: SPEC,
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
      spec: SPEC,
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
        spec: SPEC,
      })
    ).rejects.toMatchObject({ code: "outcome_unknown" });

    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        spec: SPEC,
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
        spec: SPEC,
      })
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(
      actuator.create({
        cogniKey: "k1",
        environment: "candidate-a",
        spec: SPEC,
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
        spec: SPEC,
      })
    ).rejects.toMatchObject({ code: "outcome_unknown" });

    const blocked = await actuator
      .create({ cogniKey: "k2", environment: "candidate-a", spec: SPEC })
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
      spec: SPEC,
    });
    expect(ledger.rows.get("k1")?.state).toBe("allocated");

    const second = await actuator.create({
      cogniKey: "k2",
      environment: "candidate-a",
      spec: SPEC,
    });
    expect(second.externalName).toBe("7001");
  });

  it("replays a settled key without spending again", async () => {
    const { actuator, api, log } = build();
    const first = await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      spec: SPEC,
    });
    const replay = await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      spec: SPEC,
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
        spec: SPEC,
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
        spec: SPEC,
      })
    ).rejects.toMatchObject({ code: "provider_rejected" });
  });
});

describe("AkashTxActuator.observe", () => {
  it("reads a known handle without touching the ledger", async () => {
    const { actuator, api } = build();
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
        spec: SPEC,
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
      probe: async () => {
        probes += 1;
        return true;
      },
    });
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
      probe: async () => {
        probes += 1;
        return true;
      },
    });
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
    const resource = await actuator.update({
      cogniKey: "k1",
      externalName: "7001",
      environment: "candidate-a",
      spec: SPEC,
    });
    expect(resource.externalName).toBe("7001");
    expect(api.updateCalls).toBe(1);
    expect(api.cursorCalls).toBe(0);
    expect(api.allocateCalls).toBe(0);
    expect(ledger.rows.size).toBe(0);
  });

  it("releases the provider resource and settles the key", async () => {
    const { actuator, api, ledger } = build();
    await actuator.create({
      cogniKey: "k1",
      environment: "candidate-a",
      spec: SPEC,
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
    });
    await expect(
      actuator.delete({ cogniKey: "k1", externalName: "7001" })
    ).resolves.toBeUndefined();
  });
});
