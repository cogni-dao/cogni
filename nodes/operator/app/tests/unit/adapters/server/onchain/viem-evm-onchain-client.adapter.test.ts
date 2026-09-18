// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/onchain/viem-evm-onchain-client.adapter`
 * Purpose: Prove baseline RPC health is independent of optional DAO formation.
 * Scope: Mocked viem transport and repo-spec config; no network IO.
 * Invariants: RPC_HEALTH_PRECEDES_DAO_FORMATION, BUSINESS_READS_REQUIRE_DAO_IDENTITY.
 * Side-effects: none
 * Links: src/adapters/server/onchain/viem-evm-onchain-client.adapter.ts, bug.5175
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  getBlockNumber: vi.fn(),
  getDaoConfig: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: (...args: unknown[]) =>
      mocks.createPublicClient(...args),
  };
});

vi.mock("@/shared/config/repoSpec.server", () => ({
  getDaoConfig: () => mocks.getDaoConfig(),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ EVM_RPC_URL: "https://base.example.test" }),
}));

import { ViemEvmOnchainClient } from "@/adapters/server/onchain/viem-evm-onchain-client.adapter";

describe("ViemEvmOnchainClient RPC health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDaoConfig.mockReturnValue(null);
    mocks.getBlockNumber.mockResolvedValue(123n);
    mocks.createPublicClient.mockReturnValue({
      getBlockNumber: mocks.getBlockNumber,
    });
  });

  it("reads the Base block before DAO governance is configured", async () => {
    const client = new ViemEvmOnchainClient();

    await expect(client.getBlockNumber()).resolves.toBe(123n);
    expect(mocks.getDaoConfig).not.toHaveBeenCalled();
    expect(mocks.getBlockNumber).toHaveBeenCalledOnce();
  });

  it("keeps DAO identity mandatory for treasury business reads", async () => {
    const client = new ViemEvmOnchainClient();

    await expect(
      client.getNativeBalance("0x0000000000000000000000000000000000000001")
    ).rejects.toThrow("Node DAO identity not configured");
  });
});
