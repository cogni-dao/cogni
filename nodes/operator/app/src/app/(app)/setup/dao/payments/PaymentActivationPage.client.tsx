// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/dao/payments/PaymentActivationPage.client`
 * Purpose: Client-side payment activation — deploy Split contract via user's connected wallet.
 * Scope: Reads operator wallet + DAO treasury from server props (repo-spec), deploys Split via wagmi. Does not handle Privy provisioning.
 * Invariants: SPLIT_CONTROLLER_IS_ADMIN — user's wallet is the Split controller. Addresses from repo-spec, not user input.
 * Side-effects: IO (wagmi wallet transactions)
 * Links: docs/spec/node-formation.md
 * @public
 */

"use client";

import { PUSH_SPLIT_V2o2_FACTORY_ADDRESS } from "@0xsplits/splits-sdk/constants";
import { splitV2o2FactoryAbi } from "@0xsplits/splits-sdk/constants/abi";
import {
  calculateSplitAllocations,
  OPENROUTER_CRYPTO_FEE_PPM,
  SPLIT_TOTAL_ALLOCATION,
} from "@cogni/operator-wallet";
import {
  AlertTriangle,
  CheckCircle,
  Info,
  Loader2,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { decodeEventLog, getAddress } from "viem";
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { Button, HintText, PageContainer, SectionCard } from "@/components";

/** Default billing constants (PPM). */
const DEFAULT_MARKUP_PPM = 2_000_000n;
const DEFAULT_REVENUE_SHARE_PPM = 750_000n;

type ActivationPhase =
  | "IDLE"
  | "DEPLOYING"
  | "AWAITING_CONFIRMATION"
  | "SUCCESS"
  | "ERROR";

interface Props {
  /** From repo-spec operator_wallet.address (legacy flow) or nodes.operator_wallet_address (wizard flow) — null if not configured */
  operatorWalletAddress: string | null;
  /** From repo-spec cogni_dao.dao_contract (legacy flow) or nodes.dao_address (wizard flow) — null if not configured */
  daoTreasuryAddress: string | null;
  /** When invoked via the external-node wizard (`?nodeId=...`), persist the Split address back to the node row on success. */
  nodeId?: string | null;
}

export function PaymentActivationPageClient({
  operatorWalletAddress,
  daoTreasuryAddress,
  nodeId,
}: Props): ReactElement {
  const { address: walletAddress } = useAccount();
  const router = useRouter();
  const patchedRef = useRef(false);

  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<ActivationPhase>("IDLE");
  const [splitAddress, setSplitAddress] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Wagmi
  const {
    writeContract,
    data: txHash,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract();

  const { data: receipt, error: receiptError } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Readiness checks
  const hasOperator = !!operatorWalletAddress;
  const hasTreasury = !!daoTreasuryAddress;
  const isReady = hasOperator && hasTreasury;
  const canSubmit = isReady && confirmed && phase === "IDLE" && !!walletAddress;

  // Derive allocations
  const { operatorAllocation, treasuryAllocation } = calculateSplitAllocations(
    DEFAULT_MARKUP_PPM,
    DEFAULT_REVENUE_SHARE_PPM,
    OPENROUTER_CRYPTO_FEE_PPM
  );

  const handleDeploy = useCallback(() => {
    if (
      !canSubmit ||
      !walletAddress ||
      !operatorWalletAddress ||
      !daoTreasuryAddress
    )
      return;

    setPhase("DEPLOYING");
    setErrorMessage(null);
    setSplitAddress(null);

    const operator = getAddress(operatorWalletAddress) as Address;
    const treasury = getAddress(daoTreasuryAddress) as Address;

    // Sort recipients ascending (0xSplits requirement)
    const entries = [
      { address: operator, allocation: operatorAllocation },
      { address: treasury, allocation: treasuryAllocation },
    ].sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );

    const splitParams = {
      recipients: entries.map((e) => e.address) as readonly Address[],
      allocations: entries.map((e) => e.allocation) as readonly bigint[],
      totalAllocation: SPLIT_TOTAL_ALLOCATION,
      distributionIncentive: 0,
    };

    writeContract({
      address: getAddress(PUSH_SPLIT_V2o2_FACTORY_ADDRESS) as Address,
      abi: splitV2o2FactoryAbi,
      functionName: "createSplit",
      args: [
        splitParams,
        operator, // owner/controller — operator wallet can update allocations programmatically
        walletAddress as Address, // creator — the deployer who signs this tx
      ],
    });
  }, [
    canSubmit,
    walletAddress,
    operatorWalletAddress,
    daoTreasuryAddress,
    operatorAllocation,
    treasuryAllocation,
    writeContract,
  ]);

  // Effect: tx hash received
  useEffect(() => {
    if (txHash && phase === "DEPLOYING") {
      setPhase("AWAITING_CONFIRMATION");
    }
  }, [txHash, phase]);

  // Effect: receipt confirmed
  useEffect(() => {
    if (receipt && phase === "AWAITING_CONFIRMATION") {
      let addr: string | undefined;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: splitV2o2FactoryAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "SplitCreated") {
            addr = (decoded.args as { split: Address }).split;
            break;
          }
        } catch {
          // Not our event
        }
      }
      if (addr) {
        setSplitAddress(addr);
        setPhase("SUCCESS");
      } else {
        setErrorMessage("Could not extract Split address from receipt");
        setPhase("ERROR");
      }
    }
  }, [receipt, phase]);

  // Effect: errors
  useEffect(() => {
    if (writeError && phase === "DEPLOYING") {
      setErrorMessage(writeError.message || "Split deployment failed");
      setPhase("ERROR");
    }
  }, [writeError, phase]);

  useEffect(() => {
    if (receiptError && phase === "AWAITING_CONFIRMATION") {
      setErrorMessage(receiptError.message || "Transaction failed");
      setPhase("ERROR");
    }
  }, [receiptError, phase]);

  // When invoked from the external-node wizard, PATCH the Split address back to
  // the node row and redirect to the dashboard. No-op when nodeId is absent.
  useEffect(() => {
    if (!nodeId) return;
    if (phase !== "SUCCESS" || !splitAddress) return;
    if (patchedRef.current) return;
    patchedRef.current = true;

    void (async () => {
      try {
        await fetch(`/api/v1/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: { type: "split_deployed" },
            splitAddress,
            splitTxHash: txHash,
          }),
        });
      } finally {
        router.push(`/setup/nodes/${nodeId}`);
      }
    })();
  }, [nodeId, phase, splitAddress, txHash, router]);

  const handleReset = () => {
    resetWrite();
    setPhase("IDLE");
    setSplitAddress(null);
    setErrorMessage(null);
    setConfirmed(false);
  };

  const repoSpecFragment = splitAddress
    ? `payments_in:
  credits_topup:
    provider: cogni-usdc-backend-v1
    receiving_address: "${splitAddress}"
    allowed_chains:
      - Base
    allowed_tokens:
      - USDC

payments:
  status: active`
    : "";

  const isInFlight = phase === "DEPLOYING" || phase === "AWAITING_CONFIRMATION";

  // --- Not ready: missing prerequisites ---
  if (!isReady) {
    return (
      <PageContainer maxWidth="lg">
        <SectionCard title="Activate Payments">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <AlertTriangle className="h-5 w-5" />
              <span className="font-medium">Prerequisites missing</span>
            </div>

            <div className="space-y-2 text-sm">
              {!hasTreasury && (
                <p className="text-destructive">
                  ✗ <code>cogni_dao.dao_contract</code> not found in repo-spec.
                  Complete DAO formation at the <strong>Formation</strong> tab
                  first.
                </p>
              )}
              {!hasOperator && (
                <p className="text-destructive">
                  ✗ <code>operator_wallet.address</code> not found in repo-spec.
                  Provision a Privy wallet and add the address to{" "}
                  <code>.cogni/repo-spec.yaml</code>.
                </p>
              )}
            </div>

            <HintText icon={<Info size={16} />}>
              See the operator wallet setup guide for Privy provisioning
              instructions.
            </HintText>
          </div>
        </SectionCard>
      </PageContainer>
    );
  }

  // --- Ready: show form ---
  return (
    <PageContainer maxWidth="lg">
      <SectionCard title="Activate Payments">
        <HintText icon={<Info size={16} />}>
          Deploy a revenue split contract on Base. Your connected wallet signs
          the transaction and becomes the Split controller.
        </HintText>

        {/* Read-only addresses from repo-spec */}
        <div className="space-y-2 rounded-md border bg-muted/50 p-4 text-sm">
          <p>
            <span className="font-medium">Operator wallet:</span>{" "}
            <code className="text-xs">{operatorWalletAddress}</code>
          </p>
          <p>
            <span className="font-medium">DAO treasury:</span>{" "}
            <code className="text-xs">{daoTreasuryAddress}</code>
          </p>
          <p className="text-muted-foreground">
            Operator ({Number(operatorAllocation) / 1e4}%) / Treasury (
            {Number(treasuryAllocation) / 1e4}%)
          </p>
        </div>

        {/* Confirmation checkbox */}
        {phase === "IDLE" && (
          <>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-border"
              />
              <span className="text-muted-foreground text-sm">
                I am deploying this for my new node&apos;s codebase. The
                addresses above are correct.
              </span>
            </label>

            <Button
              onClick={handleDeploy}
              disabled={!canSubmit}
              className="w-full"
            >
              Deploy Split Contract
            </Button>
          </>
        )}

        {/* In-flight */}
        {isInFlight && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground text-sm">
              {phase === "DEPLOYING"
                ? "Confirm in your wallet..."
                : "Confirming transaction..."}
            </p>
          </div>
        )}

        {/* Success */}
        {phase === "SUCCESS" && splitAddress && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">Split deployed</span>
            </div>
            <div className="rounded-md border bg-muted/50 p-3">
              <p className="mb-1 font-medium text-sm">
                Add to <code>.cogni/repo-spec.yaml</code>:
              </p>
              <pre className="overflow-x-auto text-xs">{repoSpecFragment}</pre>
            </div>
            <Button
              variant="outline"
              onClick={() => navigator.clipboard.writeText(repoSpecFragment)}
              className="w-full"
            >
              Copy to Clipboard
            </Button>
            <Button variant="ghost" onClick={handleReset} className="w-full">
              Deploy Another
            </Button>
          </div>
        )}

        {/* Error */}
        {phase === "ERROR" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              <span className="font-medium">Deployment failed</span>
            </div>
            <p className="text-muted-foreground text-sm">{errorMessage}</p>
            <Button variant="outline" onClick={handleReset} className="w-full">
              Try Again
            </Button>
          </div>
        )}
      </SectionCard>
    </PageContainer>
  );
}
