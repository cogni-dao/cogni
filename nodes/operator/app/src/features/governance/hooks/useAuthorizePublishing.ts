// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useAuthorizePublishing`
 * Purpose: Refresh-safe, explicit two-transaction ceremony for deploying the scoped distribution
 *   condition and granting the publisher CAS-native execute permission.
 * Scope: Connected-wallet writes, recovered receipt reads, condition verification, and bounded
 *   paired-permission verification. It never records activation or opens a subsequent wallet action.
 * Invariants:
 *   - WALLET_ACTIONS_ARE_EXPLICIT: receipt effects verify only; they never submit another write.
 *   - SCOPED_GRANT: grantWithCondition and the createProposal encoding are unchanged.
 *   - PAIRED_CAS_PROOF: exact atomic publish is allowed and its non-atomic twin is denied.
 *   - RECOVERY_IS_READ_ONLY: recovered public hashes only reconstruct receipts and chain reads.
 * Side-effects: connected-wallet transactions and public RPC reads.
 * Links: src/features/nodes/DistributionsCard.client.tsx,
 *   src/features/nodes/distribution-activation-recovery.ts
 * @public
 */

"use client";

import {
  CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
  DISTRIBUTION_PUBLISH_CONDITION_ABI,
  DISTRIBUTION_PUBLISH_CONDITION_BYTECODE,
} from "@cogni/cogni-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData } from "viem";
import {
  useAccount,
  useDeployContract,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import {
  buildPublishPermissionProbe,
  DAO_ABI,
  EXECUTE_PERMISSION_ID,
  TOKEN_VOTING_ABI,
} from "@/features/governance/lib/proposal-abis";

const VOTE_OPTION_YES = 2;
const VERIFY_ATTEMPTS = 4;
const VERIFY_DELAY_MS = 750;

type AuthorizationTransactionKey = "deployCondition" | "grantPermission";
type AuthorizationTransactionStatus =
  | "pending"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "unknown"
  | "failed";

interface AuthorizationTransactionState {
  readonly hash: `0x${string}` | undefined;
  readonly status: AuthorizationTransactionStatus;
}

type AuthorizationActionGuard = <T>(
  action: AuthorizationTransactionKey,
  execute: () => Promise<T>
) => Promise<T | undefined>;

export type AuthorizationVerificationStatus =
  | "idle"
  | "checking"
  | "condition_verified"
  | "verified"
  | "mismatch"
  | "unavailable";

export interface AuthorizePublishingInput {
  readonly token: `0x${string}`;
  readonly distributor: `0x${string}`;
  readonly dao: `0x${string}`;
  readonly plugin: `0x${string}`;
  readonly wallet: `0x${string}`;
  readonly chainId: number;
}

export interface AuthorizePublishingRecovery {
  readonly hashes: Partial<
    Readonly<Record<AuthorizationTransactionKey, `0x${string}`>>
  >;
  readonly onHash: (
    key: AuthorizationTransactionKey,
    hash: `0x${string}`
  ) => void;
  readonly runGuarded: AuthorizationActionGuard;
}

export interface AuthorizePublishingResult {
  readonly conditionAddress: `0x${string}` | null;
  readonly conditionTransaction: AuthorizationTransactionState;
  readonly grantTransaction: AuthorizationTransactionState;
  readonly verificationStatus: AuthorizationVerificationStatus;
  readonly error: string | null;
  readonly deployCondition: () => Promise<void>;
  readonly grantPermission: () => Promise<void>;
}

function transactionStatus(params: {
  hash: `0x${string}` | undefined;
  receiptStatus: "success" | "reverted" | undefined;
  isLoading: boolean;
  hasError: boolean;
}): AuthorizationTransactionStatus {
  if (!params.hash) return "pending";
  if (params.receiptStatus === "reverted") return "failed";
  if (params.hasError) return "unknown";
  if (params.receiptStatus === "success") return "confirmed";
  return params.isLoading ? "confirming" : "submitted";
}

function canSubmitTransaction(
  transaction: AuthorizationTransactionState
): boolean {
  return !transaction.hash || transaction.status === "failed";
}

function addressesMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Drive condition deploy and scoped grant as two explicit actions. */
export function useAuthorizePublishing(
  input: AuthorizePublishingInput,
  recovery: AuthorizePublishingRecovery
): AuthorizePublishingResult {
  const { token, distributor, dao, plugin, wallet, chainId } = input;
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const [actionError, setActionError] = useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] =
    useState<AuthorizationVerificationStatus>("idle");
  const verificationRun = useRef(0);

  const conditionTx = recovery.hashes.deployCondition;
  const grantTx = recovery.hashes.grantPermission;
  const { deployContractAsync, error: conditionError } = useDeployContract();
  const { writeContractAsync, error: grantError } = useWriteContract();
  const conditionWait = useWaitForTransactionReceipt({ hash: conditionTx });
  const grantWait = useWaitForTransactionReceipt({ hash: grantTx });
  const conditionAddress =
    conditionWait.data?.status === "success"
      ? (conditionWait.data.contractAddress ?? null)
      : null;

  const conditionTransaction = useMemo<AuthorizationTransactionState>(
    () => ({
      hash: conditionTx,
      status: transactionStatus({
        hash: conditionTx,
        receiptStatus: conditionWait.data?.status,
        isLoading: conditionWait.isLoading,
        hasError: Boolean(conditionWait.error),
      }),
    }),
    [
      conditionTx,
      conditionWait.data?.status,
      conditionWait.isLoading,
      conditionWait.error,
    ]
  );
  const grantTransaction = useMemo<AuthorizationTransactionState>(
    () => ({
      hash: grantTx,
      status: transactionStatus({
        hash: grantTx,
        receiptStatus: grantWait.data?.status,
        isLoading: grantWait.isLoading,
        hasError: Boolean(grantWait.error),
      }),
    }),
    [grantTx, grantWait.data?.status, grantWait.isLoading, grantWait.error]
  );

  useEffect(() => {
    const run = ++verificationRun.current;
    if (!conditionTx) {
      setVerificationStatus("idle");
      return;
    }
    if (conditionTransaction.status === "failed") {
      setVerificationStatus("mismatch");
      return;
    }
    if (!conditionAddress || !publicClient) {
      setVerificationStatus("checking");
      return;
    }
    if (grantTx && grantTransaction.status !== "confirmed") {
      setVerificationStatus(
        grantTransaction.status === "failed" ? "mismatch" : "checking"
      );
      return;
    }

    setVerificationStatus("checking");
    const attempts =
      grantTransaction.status === "confirmed" ? VERIFY_ATTEMPTS : 1;
    void (async () => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const [conditionToken, conditionDistributor] = await Promise.all([
            publicClient.readContract({
              abi: DISTRIBUTION_PUBLISH_CONDITION_ABI,
              address: conditionAddress,
              functionName: "token",
            }),
            publicClient.readContract({
              abi: DISTRIBUTION_PUBLISH_CONDITION_ABI,
              address: conditionAddress,
              functionName: "distributor",
            }),
          ]);
          if (run !== verificationRun.current) return;
          if (
            !addressesMatch(conditionToken, token) ||
            !addressesMatch(conditionDistributor, distributor)
          ) {
            setVerificationStatus("mismatch");
            return;
          }
          if (!grantTx) {
            setVerificationStatus("condition_verified");
            return;
          }

          const liveRoot = await publicClient.readContract({
            abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
            address: distributor,
            functionName: "merkleRoot",
          });
          const validData = buildPublishPermissionProbe(
            token,
            distributor,
            liveRoot,
            0n
          );
          const nonAtomicData = buildPublishPermissionProbe(
            token,
            distributor,
            liveRoot,
            1n
          );
          const [valid, nonAtomic] = await Promise.all([
            publicClient.readContract({
              abi: DAO_ABI,
              address: dao,
              functionName: "hasPermission",
              args: [dao, wallet, EXECUTE_PERMISSION_ID, validData],
            }),
            publicClient.readContract({
              abi: DAO_ABI,
              address: dao,
              functionName: "hasPermission",
              args: [dao, wallet, EXECUTE_PERMISSION_ID, nonAtomicData],
            }),
          ]);
          if (run !== verificationRun.current) return;
          if (valid === true && nonAtomic === false) {
            setVerificationStatus("verified");
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
    conditionAddress,
    conditionTransaction.status,
    conditionTx,
    dao,
    distributor,
    grantTransaction.status,
    grantTx,
    publicClient,
    token,
    wallet,
  ]);

  const deployCondition = useCallback(async () => {
    if (!account || !canSubmitTransaction(conditionTransaction)) {
      return;
    }
    setActionError(null);
    try {
      const hash = await recovery.runGuarded("deployCondition", () =>
        deployContractAsync({
          abi: DISTRIBUTION_PUBLISH_CONDITION_ABI,
          bytecode: DISTRIBUTION_PUBLISH_CONDITION_BYTECODE,
          args: [token, distributor],
          account,
        })
      );
      if (!hash) {
        setActionError("Condition deployment is already open in this browser.");
        return;
      }
      recovery.onHash("deployCondition", hash);
    } catch (error) {
      setActionError(
        error instanceof Error && error.message.includes("User rejected")
          ? "Transaction cancelled."
          : error instanceof Error
            ? error.message
            : "Condition deployment failed."
      );
    }
  }, [
    account,
    conditionTransaction,
    deployContractAsync,
    distributor,
    recovery,
    token,
  ]);

  const grantPermission = useCallback(async () => {
    if (
      !account ||
      !conditionAddress ||
      !canSubmitTransaction(grantTransaction)
    ) {
      return;
    }
    setActionError(null);
    const grantData = encodeFunctionData({
      abi: DAO_ABI,
      functionName: "grantWithCondition",
      args: [dao, wallet, EXECUTE_PERMISSION_ID, conditionAddress],
    });
    const grantAction = { to: dao, value: 0n, data: grantData } as const;
    try {
      const hash = await recovery.runGuarded("grantPermission", () =>
        writeContractAsync({
          abi: TOKEN_VOTING_ABI,
          address: plugin,
          functionName: "createProposal",
          args: ["0x", [grantAction], 0n, 0n, 0n, VOTE_OPTION_YES, true],
          account: wallet,
          gas: 3_000_000n,
        })
      );
      if (!hash) {
        setActionError("Permission grant is already open in this browser.");
        return;
      }
      recovery.onHash("grantPermission", hash);
    } catch (error) {
      setActionError(
        error instanceof Error && error.message.includes("User rejected")
          ? "Transaction cancelled."
          : error instanceof Error
            ? error.message
            : "Permission grant failed."
      );
    }
  }, [
    account,
    conditionAddress,
    dao,
    grantTransaction,
    plugin,
    recovery,
    wallet,
    writeContractAsync,
  ]);

  const walletError = conditionError ?? grantError;
  const receiptError = conditionWait.error ?? grantWait.error;
  const error =
    actionError ??
    (walletError?.message?.includes("User rejected")
      ? "Transaction cancelled."
      : (walletError?.message ?? receiptError?.message ?? null));

  return {
    conditionAddress,
    conditionTransaction,
    grantTransaction,
    verificationStatus,
    error,
    deployCondition,
    grantPermission,
  };
}
