// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/useDeployDistributor`
 * Purpose: Refresh-safe wallet ceremony for deploying the cumulative distributor and transferring
 *   ownership to the node DAO. Public hashes may be recovered, but receipts and owner/token reads
 *   are reconstructed from chain before the setup advances.
 * Scope: Client-side wagmi writes, receipt reads, and bounded post-confirmation verification.
 * Invariants:
 *   - WALLET_ACTIONS_ARE_EXPLICIT: a receipt never opens the next wallet transaction.
 *   - CHAIN_IS_AUTHORITY: a cached hash is only a lookup key; owner/token reads prove completion.
 *   - DEPLOY_SHAPE_STABLE: bytecode, constructor args, ownership call, and accounts are unchanged.
 * Side-effects: connected-wallet transactions and public RPC reads.
 * Links: src/features/nodes/DistributionsCard.client.tsx,
 *   src/features/nodes/distribution-activation-recovery.ts
 * @public
 */

"use client";

import {
  CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
  CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE,
} from "@cogni/cogni-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useDeployContract,
  usePublicClient,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import type {
  ActivationActionGuard,
  ActivationTransactionHashes,
  ActivationTransactionKey,
} from "@/features/nodes/distribution-activation-recovery";

const VERIFY_ATTEMPTS = 4;
const VERIFY_DELAY_MS = 750;

export type ActivationTransactionStatus =
  | "pending"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "unknown"
  | "failed";

export interface ActivationTransactionState {
  readonly hash: `0x${string}` | undefined;
  readonly status: ActivationTransactionStatus;
}

/** A missing transaction can start; a proven revert can be explicitly replaced. */
export function canSubmitActivationTransaction(
  transaction: ActivationTransactionState
): boolean {
  return !transaction.hash || transaction.status === "failed";
}

export type DistributorVerificationStatus =
  | "idle"
  | "checking"
  | "needs_transfer"
  | "verified"
  | "mismatch"
  | "unavailable";

export interface DeployDistributorRecovery {
  readonly hashes: ActivationTransactionHashes;
  readonly onHash: (key: ActivationTransactionKey, hash: `0x${string}`) => void;
  readonly runGuarded: ActivationActionGuard;
}

export interface DeployDistributorResult {
  readonly distributorAddress: `0x${string}` | null;
  readonly deployTransaction: ActivationTransactionState;
  readonly transferTransaction: ActivationTransactionState;
  readonly verificationStatus: DistributorVerificationStatus;
  readonly error: string | null;
  readonly deploy: () => Promise<void>;
  readonly transferOwnership: () => Promise<void>;
}

function transactionStatus(params: {
  hash: `0x${string}` | undefined;
  receiptStatus: "success" | "reverted" | undefined;
  isLoading: boolean;
  hasError: boolean;
}): ActivationTransactionStatus {
  if (!params.hash) return "pending";
  if (params.receiptStatus === "reverted") return "failed";
  if (params.hasError) return "unknown";
  if (params.receiptStatus === "success") return "confirmed";
  return params.isLoading ? "confirming" : "submitted";
}

function addressesMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Drive two explicit wallet actions; recovered hashes never call either action. */
export function useDeployDistributor(
  tokenAddress: `0x${string}`,
  daoAddress: `0x${string}`,
  chainId: number,
  recovery: DeployDistributorRecovery
): DeployDistributorResult {
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const [actionError, setActionError] = useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] =
    useState<DistributorVerificationStatus>("idle");
  const verificationRun = useRef(0);

  const deployTx = recovery.hashes.deployDistributor;
  const transferTx = recovery.hashes.transferOwnership;

  const { deployContractAsync, error: deployError } = useDeployContract();
  const { writeContractAsync, error: transferError } = useWriteContract();
  const deployWait = useWaitForTransactionReceipt({ hash: deployTx });
  const transferWait = useWaitForTransactionReceipt({ hash: transferTx });

  const distributorAddress =
    deployWait.data?.status === "success"
      ? (deployWait.data.contractAddress ?? null)
      : null;

  const deployTransaction = useMemo<ActivationTransactionState>(
    () => ({
      hash: deployTx,
      status: transactionStatus({
        hash: deployTx,
        receiptStatus: deployWait.data?.status,
        isLoading: deployWait.isLoading,
        hasError: Boolean(deployWait.error),
      }),
    }),
    [deployTx, deployWait.data?.status, deployWait.isLoading, deployWait.error]
  );
  const transferTransaction = useMemo<ActivationTransactionState>(
    () => ({
      hash: transferTx,
      status: transactionStatus({
        hash: transferTx,
        receiptStatus: transferWait.data?.status,
        isLoading: transferWait.isLoading,
        hasError: Boolean(transferWait.error),
      }),
    }),
    [
      transferTx,
      transferWait.data?.status,
      transferWait.isLoading,
      transferWait.error,
    ]
  );

  useEffect(() => {
    const run = ++verificationRun.current;
    if (!deployTx) {
      setVerificationStatus("idle");
      return;
    }
    if (deployTransaction.status === "failed") {
      setVerificationStatus("mismatch");
      return;
    }
    if (!distributorAddress || !publicClient) {
      setVerificationStatus("checking");
      return;
    }
    if (transferTx && transferTransaction.status !== "confirmed") {
      setVerificationStatus(
        transferTransaction.status === "failed" ? "needs_transfer" : "checking"
      );
      return;
    }

    setVerificationStatus("checking");
    const attempts =
      transferTransaction.status === "confirmed" ? VERIFY_ATTEMPTS : 1;
    void (async () => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const [owner, token] = await Promise.all([
            publicClient.readContract({
              abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
              address: distributorAddress,
              functionName: "owner",
            }),
            publicClient.readContract({
              abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
              address: distributorAddress,
              functionName: "token",
            }),
          ]);
          if (run !== verificationRun.current) return;
          if (!addressesMatch(token, tokenAddress)) {
            setVerificationStatus("mismatch");
            return;
          }
          if (addressesMatch(owner, daoAddress)) {
            setVerificationStatus("verified");
            return;
          }
          if (!transferTx) {
            setVerificationStatus("needs_transfer");
            return;
          }
          if (attempt === attempts - 1) {
            setVerificationStatus("mismatch");
            return;
          }
        } catch {
          if (run !== verificationRun.current) return;
          if (attempt === attempts - 1) {
            setVerificationStatus("unavailable");
            return;
          }
        }
        await wait(VERIFY_DELAY_MS);
      }
    })();
  }, [
    daoAddress,
    deployTransaction.status,
    deployTx,
    distributorAddress,
    publicClient,
    tokenAddress,
    transferTransaction.status,
    transferTx,
  ]);

  const deploy = useCallback(async () => {
    if (!account || !canSubmitActivationTransaction(deployTransaction)) return;
    setActionError(null);
    try {
      const hash = await recovery.runGuarded("deployDistributor", () =>
        deployContractAsync({
          abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
          bytecode: CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE,
          args: [tokenAddress],
          account,
        })
      );
      if (!hash) {
        setActionError(
          "Distributor deployment is already open in this browser."
        );
        return;
      }
      recovery.onHash("deployDistributor", hash);
    } catch (error) {
      setActionError(
        error instanceof Error && error.message.includes("User rejected")
          ? "Transaction cancelled."
          : error instanceof Error
            ? error.message
            : "Distributor deployment failed."
      );
    }
  }, [account, deployContractAsync, deployTransaction, recovery, tokenAddress]);

  const transferOwnership = useCallback(async () => {
    if (
      !account ||
      !distributorAddress ||
      !canSubmitActivationTransaction(transferTransaction)
    ) {
      return;
    }
    setActionError(null);
    try {
      const hash = await recovery.runGuarded("transferOwnership", () =>
        writeContractAsync({
          abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
          address: distributorAddress,
          functionName: "transferOwnership",
          args: [daoAddress],
          account,
        })
      );
      if (!hash) {
        setActionError("Ownership transfer is already open in this browser.");
        return;
      }
      recovery.onHash("transferOwnership", hash);
    } catch (error) {
      setActionError(
        error instanceof Error && error.message.includes("User rejected")
          ? "Transaction cancelled."
          : error instanceof Error
            ? error.message
            : "Ownership transfer failed."
      );
    }
  }, [
    account,
    daoAddress,
    distributorAddress,
    recovery,
    transferTransaction,
    writeContractAsync,
  ]);

  const walletError = deployError ?? transferError;
  const receiptError = deployWait.error ?? transferWait.error;
  const error =
    actionError ??
    (walletError?.message?.includes("User rejected")
      ? "Transaction cancelled."
      : (walletError?.message ?? receiptError?.message ?? null));

  return {
    distributorAddress,
    deployTransaction,
    transferTransaction,
    verificationStatus,
    error,
    deploy,
    transferOwnership,
  };
}

export interface DistributorOnChainState {
  readonly status: "idle" | "loading" | "verified" | "mismatch" | "unavailable";
  readonly owner: `0x${string}` | null;
  readonly token: `0x${string}` | null;
}

/** Live proof for a distributor address learned from the repo, an activation PR, or a receipt. */
export function useDistributorOnChain(params: {
  readonly distributorAddress: `0x${string}` | null;
  readonly daoAddress: `0x${string}`;
  readonly tokenAddress: `0x${string}`;
  readonly chainId: number;
}): DistributorOnChainState {
  const { distributorAddress, daoAddress, tokenAddress, chainId } = params;
  const enabled = distributorAddress !== null;
  const address =
    distributorAddress ?? "0x0000000000000000000000000000000000000000";
  const { data, isLoading, error } = useReadContracts({
    contracts: [
      {
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        address,
        functionName: "owner",
        chainId,
      },
      {
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        address,
        functionName: "token",
        chainId,
      },
    ],
    query: { enabled },
  });

  if (!enabled) return { status: "idle", owner: null, token: null };
  if (isLoading) return { status: "loading", owner: null, token: null };
  const ownerResult = data?.[0];
  const tokenResult = data?.[1];
  const owner =
    ownerResult?.status === "success" && typeof ownerResult.result === "string"
      ? (ownerResult.result as `0x${string}`)
      : null;
  const token =
    tokenResult?.status === "success" && typeof tokenResult.result === "string"
      ? (tokenResult.result as `0x${string}`)
      : null;
  if (error || !owner || !token) {
    return { status: "unavailable", owner, token };
  }
  const verified =
    addressesMatch(owner, daoAddress) && addressesMatch(token, tokenAddress);
  return { status: verified ? "verified" : "mismatch", owner, token };
}
