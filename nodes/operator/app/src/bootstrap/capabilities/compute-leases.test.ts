// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `bootstrap/capabilities/compute-leases.test`
 * Purpose: Pin native test-mode isolation at the application composition seam.
 * Scope: Real capability factory with mocked adapter constructors; no DB or network.
 * Invariants: configured test accounts keep ledger reads and never construct public transport.
 * Side-effects: scoped global fetch stub, restored after each case.
 * Links: bug.5556; node-test-contract
 * @internal
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "@/shared/env";
import { createLeaseReadCapability } from "./compute-leases";

const { ledger, ledgerConstructor, nativeConstructor, nativeRead } = vi.hoisted(
  () => {
    const ledger = {
      read: vi.fn(),
      listAllocated: vi.fn(),
      listReceipts: vi.fn(),
    };
    const nativeRead = vi.fn();
    return {
      ledger,
      ledgerConstructor: vi.fn(
        class {
          read = ledger.read;
          listAllocated = ledger.listAllocated;
          listReceipts = ledger.listReceipts;
        }
      ),
      nativeConstructor: vi.fn(
        class {
          readMany = nativeRead;
        }
      ),
      nativeRead,
    };
  }
);
vi.mock("@/adapters/server", () => ({
  DrizzleAkashTxAllocationLedger: ledgerConstructor,
  AkashNativeStateReader: nativeConstructor,
}));
vi.mock("@/shared/observability", () => ({
  makeLogger: () => ({ info: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.clearAllMocks());

describe("createLeaseReadCapability native composition", () => {
  const accountId = "akash1configured";
  // Other environment fields are not consumed by this factory.
  const env = (isTestMode: boolean) =>
    ({ AKASH_ACTUATOR_ACCOUNT_ID: accountId, isTestMode }) as ServerEnv;

  it("keeps configured test-mode ledger reads while native evidence is unknown with zero public I/O", async () => {
    const publicFetch = vi.fn(() => {
      throw new Error("unexpected public I/O");
    });
    vi.stubGlobal("fetch", publicFetch);
    const getDb = vi.fn();
    const capability = createLeaseReadCapability(env(true), getDb);
    expect(capability).toBeDefined();
    const receipt = { cogniKey: "exact" };
    ledger.read.mockResolvedValue(receipt);
    expect(await capability?.read({ cogniKey: "exact" })).toBe(receipt);
    expect(ledger.read).toHaveBeenCalledWith({ cogniKey: "exact" });
    expect(ledgerConstructor).toHaveBeenCalledWith(getDb, expect.any(String));
    const result = await capability?.readNativeStates({
      dseqs: ["7001", "7002", "7001"],
    });
    const unknown = {
      source: null,
      observedAt: null,
      deploymentState: null,
      deploymentCoverage: "unknown",
      deploymentObservedAt: null,
      leaseStates: [],
      leaseCoverage: "unknown",
      leasePages: [],
      errorCode: "not_requested",
    };
    expect(result).toEqual({ "7001": unknown, "7002": unknown });
    expect(nativeConstructor).not.toHaveBeenCalled();
    expect(nativeRead).not.toHaveBeenCalled();
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("binds the real public reader outside test mode using only the configured account", async () => {
    const publicFetch = vi.fn();
    vi.stubGlobal("fetch", publicFetch);
    const capability = createLeaseReadCapability(env(false), vi.fn());
    const observation = { "7001": { deploymentCoverage: "unknown" } };
    nativeRead.mockResolvedValue(observation);
    const input = { dseqs: ["7001"] };
    expect(await capability?.readNativeStates(input)).toBe(observation);
    expect(nativeConstructor).toHaveBeenCalledWith(
      accountId,
      publicFetch,
      expect.any(Object)
    );
    expect(nativeRead).toHaveBeenCalledWith(input);
  });
});
