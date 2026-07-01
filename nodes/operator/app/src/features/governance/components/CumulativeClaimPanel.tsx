"use client";

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/CumulativeClaimPanel`
 * Purpose: Wallet-connected panel on /gov/holdings letting the connected wallet claim its CUMULATIVE DAO tokens (all unclaimed epochs at once).
 * Scope: Client component. Connect wallet → useCumulativeClaim (latest manifest leaf + on-chain cumulativeClaimed) → call CumulativeMerkleDrop.claim() via wagmi. Does not perform DB access.
 * Invariants:
 *   - CUMULATIVE_MODEL: claim(account, cumulativeAmount, root, proof) pays cumulativeAmount − cumulativeClaimed. A single claim covers ALL unclaimed epochs.
 *   - HONEST_STATE: after a claim tx confirms, re-read cumulativeClaimed so claimable reflects 0 until the next root.
 *   - ALL_MATH_BIGINT: amounts stay bigint; formatted only at display.
 *   - PUBLIC_NO_SECRETS: all inputs come from the public latest-distribution route + the connected wallet.
 * Side-effects: blockchain read (cumulativeClaimed via hook), blockchain write (claim tx via wallet signing).
 * Links: nodes/operator/app/src/features/governance/hooks/useCumulativeClaim.ts, packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts
 * @public
 */

import { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
import { getTransactionExplorerUrl } from "@cogni/node-shared";
import { useCallback, useEffect } from "react";
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  WalletConnectButton,
} from "@/components";
import { useCumulativeClaim } from "@/features/governance/hooks/useCumulativeClaim";
import { getChainName } from "@/features/governance/lib/proposal-utils";

export function CumulativeClaimPanel() {
  const { address, isConnected } = useAccount();

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader>
        <CardTitle>Claim your tokens</CardTitle>
        <CardDescription>
          A single claim releases every unclaimed epoch you&apos;ve earned. The
          contract pays out your cumulative allocation minus whatever
          you&apos;ve already claimed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!isConnected || !address ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              Connect your wallet to check what you can claim.
            </p>
            <WalletConnectButton />
          </div>
        ) : (
          <ConnectedClaim account={address} />
        )}
      </CardContent>
    </Card>
  );
}

function ConnectedClaim({ account }: { account: `0x${string}` }) {
  const {
    claim,
    cumulativeClaimed,
    claimable,
    isLoading,
    isClaimedLoading,
    error,
    refetchClaimed,
  } = useCumulativeClaim(account);

  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const {
    writeContract,
    isPending,
    error: writeError,
    data: txHash,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // HONEST_STATE: re-read cumulativeClaimed once the claim tx confirms so
  // claimable collapses to 0 until the next cumulative root is published.
  useEffect(() => {
    if (isConfirmed) refetchClaimed();
  }, [isConfirmed, refetchClaimed]);

  const distributor = (claim?.distributor ?? null) as `0x${string}` | null;
  const isCorrectChain = claim ? chainId === claim.chainId : true;
  const chainName = claim ? getChainName(claim.chainId) : "";
  const explorerUrl =
    txHash && claim ? getTransactionExplorerUrl(claim.chainId, txHash) : null;

  const onClaim = useCallback(() => {
    if (!claim || !distributor || !isCorrectChain) return;
    writeContract({
      abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
      address: distributor,
      functionName: "claim",
      // claim(account, cumulativeAmount, expectedMerkleRoot, merkleProof)
      args: [
        claim.account as `0x${string}`,
        BigInt(claim.amount),
        claim.root as `0x${string}`,
        claim.proof as `0x${string}`[],
      ],
      account,
    });
  }, [claim, distributor, isCorrectChain, writeContract, account]);

  if (isLoading) {
    return (
      <p className="text-muted-foreground text-sm">
        Checking your allocation&hellip;
      </p>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load your claim</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  // No leaf for this wallet in the latest manifest → no allocation.
  if (!claim) {
    return (
      <Alert>
        <AlertTitle>No allocation for this wallet</AlertTitle>
        <AlertDescription>
          This wallet has no cumulative token allocation yet. If you contributed
          with a different wallet, connect that one.
        </AlertDescription>
      </Alert>
    );
  }

  const cumulativeAmount = BigInt(claim.amount);

  return (
    <div className="space-y-5">
      <AllocationSummary
        cumulativeAmount={cumulativeAmount}
        cumulativeClaimed={cumulativeClaimed}
        claimable={claimable}
        chainName={chainName}
      />

      {/* Distributor not yet recorded (R2 repo-spec distributorAddress). */}
      {!distributor ? (
        <Alert>
          <AlertTitle>Claiming not open yet</AlertTitle>
          <AlertDescription>
            The distribution contract for this node hasn&apos;t been recorded
            yet. Check back once tokens are on-chain.
          </AlertDescription>
        </Alert>
      ) : isClaimedLoading || claimable === undefined ? (
        <p className="text-muted-foreground text-sm">
          Reading on-chain claim state&hellip;
        </p>
      ) : claimable === 0n ? (
        <Alert>
          <AlertTitle>Nothing to claim right now</AlertTitle>
          <AlertDescription>
            You&apos;ve claimed everything allocated to you so far. New tokens
            become claimable when the next cumulative root is published.
          </AlertDescription>
        </Alert>
      ) : !isCorrectChain ? (
        <Button
          variant="outline"
          onClick={() => switchChain?.({ chainId: claim.chainId })}
        >
          Switch to {chainName}
        </Button>
      ) : (
        <>
          <Button onClick={onClaim} disabled={isPending || isConfirming}>
            {isPending
              ? "Confirm in wallet…"
              : isConfirming
                ? "Claiming…"
                : `Claim ${formatAmount(claimable)}`}
          </Button>

          {explorerUrl && (isPending || isConfirming) && (
            <p className="text-muted-foreground text-sm">
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline transition-colors hover:text-foreground"
              >
                View transaction
              </a>
            </p>
          )}
        </>
      )}

      {isConfirmed && (
        <Alert>
          <AlertTitle>Tokens claimed</AlertTitle>
          <AlertDescription>
            Your claim confirmed on {chainName}.{" "}
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline transition-colors hover:text-foreground"
              >
                View transaction
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}

      {writeError && (
        <Alert variant="destructive">
          <AlertTitle>Claim failed</AlertTitle>
          <AlertDescription>
            {writeError.message?.includes("User rejected")
              ? "Transaction cancelled."
              : writeError.message?.includes("insufficient funds")
                ? "Insufficient funds for gas."
                : (writeError.message ?? "Unknown error")}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function AllocationSummary({
  cumulativeAmount,
  cumulativeClaimed,
  claimable,
  chainName,
}: {
  cumulativeAmount: bigint;
  cumulativeClaimed: bigint | undefined;
  claimable: bigint | undefined;
  chainName: string;
}) {
  return (
    <div className="rounded-lg border border-border p-5">
      <p className="text-muted-foreground text-sm">Claimable now</p>
      <p className="font-bold text-2xl tracking-tight">
        {claimable === undefined ? "…" : formatAmount(claimable)}
      </p>
      <dl className="mt-3 space-y-1 text-muted-foreground text-sm">
        <div className="flex justify-between gap-4">
          <dt>Cumulative allocation</dt>
          <dd className="font-mono">{formatAmount(cumulativeAmount)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Already claimed</dt>
          <dd className="font-mono">
            {cumulativeClaimed === undefined
              ? "…"
              : formatAmount(cumulativeClaimed)}
          </dd>
        </div>
        {chainName && (
          <div className="flex justify-between gap-4">
            <dt>Network</dt>
            <dd>{chainName}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Format an 18-decimal base-unit amount for display, trimming trailing zeros. */
function formatAmount(base: bigint): string {
  const DECIMALS = 18n;
  const divisor = 10n ** DECIMALS;
  const whole = base / divisor;
  const frac = base % divisor;
  if (frac === 0n) return `${whole.toLocaleString()} tokens`;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr.slice(0, 4)} tokens`;
}
