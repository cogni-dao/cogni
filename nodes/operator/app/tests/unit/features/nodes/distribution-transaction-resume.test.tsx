// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests for explicit distribution transaction resume.
 * Purpose: Prove recovered receipts never auto-write and a proven reverted checkpoint can be
 *   explicitly retried while retaining its evidence until the replacement submission succeeds.
 * Scope: Distributor hook with mocked wagmi wallet/RPC hooks; no chain or browser storage.
 * Side-effects: mocked React hooks only.
 * Links: src/features/nodes/useDeployDistributor.ts
 */

// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActivationActionGuard } from "@/features/nodes/distribution-activation-recovery";
import {
  canSubmitActivationTransaction,
  useDeployDistributor,
} from "@/features/nodes/useDeployDistributor";

const mocks = vi.hoisted(() => ({
  deployContractAsync: vi.fn(),
  writeContractAsync: vi.fn(),
  onHash: vi.fn(),
}));

const DEPLOY_HASH = `0x${"1".repeat(64)}` as const;
const FAILED_TRANSFER_HASH = `0x${"2".repeat(64)}` as const;
const RETRY_TRANSFER_HASH = `0x${"3".repeat(64)}` as const;
const DISTRIBUTOR = "0x4444444444444444444444444444444444444444";
const runGuarded: ActivationActionGuard = async (_action, execute) => execute();

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0x5555555555555555555555555555555555555555",
  }),
  useDeployContract: () => ({
    deployContractAsync: mocks.deployContractAsync,
    error: null,
  }),
  useWriteContract: () => ({
    writeContractAsync: mocks.writeContractAsync,
    error: null,
  }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useReadContracts: () => ({ data: undefined, isLoading: false, error: null }),
  useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => {
    if (hash === DEPLOY_HASH) {
      return {
        data: {
          status: "success",
          contractAddress: DISTRIBUTOR,
        },
        isLoading: false,
        error: null,
      };
    }
    if (hash === FAILED_TRANSFER_HASH) {
      return {
        data: { status: "reverted", contractAddress: null },
        isLoading: false,
        error: null,
      };
    }
    return { data: undefined, isLoading: false, error: null };
  },
}));

describe("distribution transaction resume", () => {
  it("allows only missing or proven-failed transactions to submit", () => {
    expect(
      canSubmitActivationTransaction({ hash: undefined, status: "pending" })
    ).toBe(true);
    expect(
      canSubmitActivationTransaction({
        hash: FAILED_TRANSFER_HASH,
        status: "failed",
      })
    ).toBe(true);
    expect(
      canSubmitActivationTransaction({ hash: DEPLOY_HASH, status: "confirmed" })
    ).toBe(false);
    expect(
      canSubmitActivationTransaction({ hash: DEPLOY_HASH, status: "unknown" })
    ).toBe(false);
  });

  it("does not auto-write a recovered revert and replaces it only on explicit retry", async () => {
    mocks.writeContractAsync.mockReset();
    mocks.onHash.mockReset();
    mocks.writeContractAsync.mockResolvedValue(RETRY_TRANSFER_HASH);
    const { result } = renderHook(() =>
      useDeployDistributor(
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        8453,
        {
          hashes: {
            deployDistributor: DEPLOY_HASH,
            transferOwnership: FAILED_TRANSFER_HASH,
          },
          onHash: mocks.onHash,
          runGuarded,
        }
      )
    );

    await waitFor(() =>
      expect(result.current.verificationStatus).toBe("needs_transfer")
    );
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
    expect(result.current.transferTransaction.hash).toBe(FAILED_TRANSFER_HASH);

    await act(async () => result.current.transferOwnership());

    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(mocks.onHash).toHaveBeenCalledWith(
      "transferOwnership",
      RETRY_TRANSFER_HASH
    );
  });
});
