"use client";

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/claim/[epoch]/claim-tokens.client`
 * Purpose: Client component letting a contributor connect a wallet and claim DAO tokens for a finalized epoch.
 * Scope: Connect wallet → fetch this account's merkle claim from the public distribution route → read isClaimed →
 *        call the stock Uniswap MerkleDistributor.claim() via wagmi → show tx + success.
 * Invariants:
 *   - STOCK_DISTRIBUTOR_ABI: uses MERKLE_DISTRIBUTOR_ABI verbatim from @cogni/cogni-contracts (no bespoke contract).
 *   - NO_ALLOCATION_IS_NOT_AN_ERROR: a 404 from the proof route means "no allocation for this wallet" — shown calmly.
 *   - PUBLIC_NO_SECRETS: all inputs come from the public proof route + the connected wallet.
 * Side-effects: HTTP read (proof fetch), blockchain read (isClaimed), blockchain write (claim tx via wallet signing).
 * Links: nodes/operator/app/src/app/api/v1/public/attribution/epochs/[id]/distribution/route.ts,
 *        packages/cogni-contracts/src/merkle-distributor/abi.ts
 * @public
 */

import { MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
import { getTransactionExplorerUrl } from "@cogni/node-shared";
import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  WalletConnectButton,
} from "@/components";
import { getChainName } from "@/features/governance/lib/proposal-utils";

/** The claim leaf + proof served by the public distribution route. */
type ClaimDto = {
  epochId: string;
  root: string;
  distributor: string | null;
  chainId: number;
  tokenAddress: string;
  index: number;
  account: string;
  amount: string;
  proof: string[];
};

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "none" } // 404 — no allocation for this wallet
  | { status: "error"; message: string }
  | { status: "found"; claim: ClaimDto };

export function ClaimTokens({ epoch }: { epoch: string }) {
  const { address, isConnected } = useAccount();
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });

  // ── Fetch this wallet's claim (leaf + proof) from the public route ──
  useEffect(() => {
    if (!isConnected || !address) {
      setFetchState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setFetchState({ status: "loading" });

    (async () => {
      try {
        const res = await fetch(
          `/api/v1/public/attribution/epochs/${encodeURIComponent(
            epoch
          )}/distribution?account=${address}`
        );

        if (cancelled) return;

        // 404 = epoch not found OR no leaf for this account. The contributor
        // simply has no allocation here — a calm message, not an error.
        if (res.status === 404) {
          setFetchState({ status: "none" });
          return;
        }

        if (!res.ok) {
          setFetchState({
            status: "error",
            message: `Failed to load claim (HTTP ${res.status}).`,
          });
          return;
        }

        const body = (await res.json()) as { claim: ClaimDto | null };
        if (cancelled) return;

        if (!body.claim) {
          setFetchState({ status: "none" });
          return;
        }
        setFetchState({ status: "found", claim: body.claim });
      } catch {
        if (!cancelled) {
          setFetchState({
            status: "error",
            message: "Network error loading your claim.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [epoch, address, isConnected]);

  return (
    <div className="space-y-8">
      <Header epoch={epoch} />

      {!isConnected ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            Connect your wallet to check your token allocation for this epoch.
          </p>
          <WalletConnectButton />
        </div>
      ) : fetchState.status === "loading" || fetchState.status === "idle" ? (
        <p className="text-muted-foreground text-sm">
          Checking your allocation…
        </p>
      ) : fetchState.status === "none" ? (
        <NoAllocation />
      ) : fetchState.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn’t load your claim</AlertTitle>
          <AlertDescription>{fetchState.message}</AlertDescription>
        </Alert>
      ) : (
        <ClaimPanel claim={fetchState.claim} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claim panel — isClaimed gate → claim() tx → success
// ---------------------------------------------------------------------------

function ClaimPanel({ claim }: { claim: ClaimDto }) {
  const { address } = useAccount();
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

  const distributor = claim.distributor as `0x${string}` | null;
  const isCorrectChain = chainId === claim.chainId;
  const chainName = getChainName(claim.chainId);

  // ── On-chain isClaimed(index) — stock view fn ──
  const {
    data: isClaimed,
    isLoading: isClaimedLoading,
    refetch: refetchClaimed,
  } = useReadContract({
    abi: MERKLE_DISTRIBUTOR_ABI,
    address: distributor ?? undefined,
    functionName: "isClaimed",
    args: [BigInt(claim.index)],
    chainId: claim.chainId,
    query: { enabled: Boolean(distributor) },
  });

  // Re-read isClaimed once a claim tx confirms so the UI flips to "claimed".
  useEffect(() => {
    if (isConfirmed) void refetchClaimed();
  }, [isConfirmed, refetchClaimed]);

  const onClaim = useCallback(() => {
    if (!distributor || !address || !isCorrectChain) return;
    writeContract({
      abi: MERKLE_DISTRIBUTOR_ABI,
      address: distributor,
      functionName: "claim",
      args: [
        BigInt(claim.index),
        claim.account as `0x${string}`,
        BigInt(claim.amount),
        claim.proof as `0x${string}`[],
      ],
      account: address,
    });
  }, [distributor, address, isCorrectChain, writeContract, claim]);

  const explorerUrl = txHash
    ? getTransactionExplorerUrl(claim.chainId, txHash)
    : null;

  // Wrong account: the connected wallet differs from the claim's bound account.
  const accountMatches = address?.toLowerCase() === claim.account.toLowerCase();

  return (
    <div className="space-y-6">
      <AllocationCard claim={claim} chainName={chainName} />

      {/* Distributor not yet deployed for this epoch. */}
      {!distributor ? (
        <Alert>
          <AlertTitle>Claiming not open yet</AlertTitle>
          <AlertDescription>
            The distribution contract for this epoch hasn’t been deployed yet.
            Check back once the epoch’s tokens are on-chain.
          </AlertDescription>
        </Alert>
      ) : !accountMatches ? (
        <Alert>
          <AlertTitle>Different wallet</AlertTitle>
          <AlertDescription>
            This allocation is bound to {short(claim.account)}. Connect that
            wallet to claim.
          </AlertDescription>
        </Alert>
      ) : isConfirmed || isClaimed ? (
        <ClaimedView explorerUrl={explorerUrl} />
      ) : (
        <>
          {!isCorrectChain ? (
            <Button
              variant="outline"
              onClick={() => switchChain?.({ chainId: claim.chainId })}
            >
              Switch to {chainName}
            </Button>
          ) : (
            <Button
              onClick={onClaim}
              disabled={isPending || isConfirming || isClaimedLoading}
            >
              {isPending
                ? "Confirm in wallet…"
                : isConfirming
                  ? "Claiming…"
                  : "Claim tokens"}
            </Button>
          )}

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
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational sub-components
// ---------------------------------------------------------------------------

function Header({ epoch }: { epoch: string }) {
  return (
    <div className="space-y-1">
      <p className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
        Cogni attribution · Epoch {epoch}
      </p>
      <h1 className="font-bold text-3xl tracking-tight">Claim your tokens</h1>
      <p className="text-muted-foreground">
        Claim the DAO tokens you earned for this finalized epoch.
      </p>
    </div>
  );
}

function AllocationCard({
  claim,
  chainName,
}: {
  claim: ClaimDto;
  chainName: string;
}) {
  return (
    <div className="rounded-lg border border-border p-5">
      <p className="text-muted-foreground text-sm">Your allocation</p>
      <p className="font-bold text-2xl tracking-tight">
        {formatAmount(claim.amount)}
      </p>
      <dl className="mt-3 space-y-1 text-muted-foreground text-sm">
        <div className="flex justify-between gap-4">
          <dt>Token</dt>
          <dd className="font-mono">{short(claim.tokenAddress)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Network</dt>
          <dd>{chainName}</dd>
        </div>
      </dl>
    </div>
  );
}

function ClaimedView({ explorerUrl }: { explorerUrl: string | null }) {
  return (
    <div className="flex flex-col items-center gap-6 py-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-success/10">
        <span className="text-3xl text-success" aria-hidden="true">
          &#x2713;
        </span>
      </div>
      <div className="space-y-1">
        <h2 className="font-bold text-2xl tracking-tight">Tokens claimed</h2>
        <p className="text-muted-foreground">
          This allocation has been claimed to your wallet.
        </p>
      </div>
      {explorerUrl && (
        <Button variant="outline" asChild>
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
            View transaction
          </a>
        </Button>
      )}
    </div>
  );
}

function NoAllocation() {
  return (
    <Alert>
      <AlertTitle>No allocation for this wallet</AlertTitle>
      <AlertDescription>
        This wallet has no token allocation in this epoch. If you contributed
        with a different wallet, connect that one — or make sure your
        contribution wallet is linked.
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Format an 18-decimal base-unit amount for display, trimming trailing zeros. */
function formatAmount(base: string): string {
  let value: bigint;
  try {
    value = BigInt(base);
  } catch {
    return `${base} tokens`;
  }
  const DECIMALS = 18n;
  const divisor = 10n ** DECIMALS;
  const whole = value / divisor;
  const frac = value % divisor;
  if (frac === 0n) return `${whole.toLocaleString()} tokens`;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr.slice(0, 4)} tokens`;
}
