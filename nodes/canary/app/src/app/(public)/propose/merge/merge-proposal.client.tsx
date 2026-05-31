"use client";

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/propose/merge/merge-proposal.client`
 * Purpose: Client component for creating a DAO governance proposal to merge a PR.
 * Scope: Reads URL params, connects wallet, encodes CogniSignal.signal() action, submits createProposal() tx.
 * Invariants: All contract addresses from URL params; no server-side config dependency.
 * Side-effects: Blockchain write (createProposal tx via wallet signing)
 * Links: cogni-proposal-launcher/src/pages/merge-change.tsx
 * @public
 */

import { getDaoUrl } from "@cogni/node-shared";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { encodeFunctionData } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  WalletConnectButton,
} from "@/components";
import {
  COGNI_SIGNAL_ABI,
  TOKEN_VOTING_ABI,
} from "@/features/governance/lib/proposal-abis";
import {
  estimateProposalGas,
  generateProposalTimestamps,
  getChainName,
  validateDeeplinkParams,
} from "@/features/governance/lib/proposal-utils";

export function MergeProposal() {
  const searchParams = useSearchParams();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { writeContract, isPending, isSuccess, error, data } =
    useWriteContract();
  const client = usePublicClient();
  const { switchChain } = useSwitchChain();

  const params = useMemo(
    () => validateDeeplinkParams(searchParams),
    [searchParams]
  );

  if (!params) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Alert variant="destructive" className="max-w-md">
          <AlertTitle>Invalid Link</AlertTitle>
          <AlertDescription>
            Missing required URL parameters. Check the link from your PR review.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const requiredChainId = parseInt(params.chainId, 10);
  const isCorrectChain = chainId === requiredChainId;
  const decodedRepoUrl = decodeURIComponent(params.repoUrl);
  const repoName = decodedRepoUrl.split("/").pop() ?? "";
  const prUrl = `${decodedRepoUrl}/pull/${params.pr}`;

  const createProposal = async () => {
    if (!client || !address || !isCorrectChain) return;

    try {
      const signalCallData = encodeFunctionData({
        abi: COGNI_SIGNAL_ABI,
        functionName: "signal",
        args: [
          "github",
          decodedRepoUrl,
          params.action,
          params.target,
          params.pr,
          "0x",
        ],
      });

      const actions = [
        {
          to: params.signal as `0x${string}`,
          value: 0n,
          data: signalCallData,
        },
      ];

      const { startDate, endDate } = generateProposalTimestamps();
      const proposalArgs: [
        `0x${string}`,
        typeof actions,
        bigint,
        bigint,
        bigint,
        number,
        boolean,
      ] = ["0x" as `0x${string}`, actions, 0n, startDate, endDate, 0, false];

      const gasLimit = await estimateProposalGas(client, {
        address: params.plugin as `0x${string}`,
        abi: TOKEN_VOTING_ABI,
        functionName: "createProposal",
        args: proposalArgs,
        account: address,
      });

      await writeContract({
        address: params.plugin as `0x${string}`,
        abi: TOKEN_VOTING_ABI,
        functionName: "createProposal",
        args: proposalArgs,
        gas: gasLimit,
        account: address,
      });
    } catch {
      // Error surfaced via useWriteContract error state
    }
  };

  const daoUrl = getDaoUrl(requiredChainId, params.dao);
  const proposalsUrl = daoUrl ? `${daoUrl}/proposals` : null;

  // ── Success ──────────────────────────────────────────────
  if (isSuccess && data) {
    return (
      <SuccessView
        proposalsUrl={proposalsUrl}
        prUrl={prUrl}
        prNumber={params.pr}
      />
    );
  }

  // ── Default ──────────────────────────────────────────────
  return (
    <div className="space-y-8">
      {/* Header — what and where */}
      <div className="space-y-1">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
          Cogni governance · {getChainName(params.chainId)}
        </p>
        <h1 className="font-bold text-3xl tracking-tight">
          {params.action} PR #{params.pr}
        </h1>
        <p className="text-muted-foreground">
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline transition-colors hover:text-foreground"
          >
            {repoName}#{params.pr}
          </a>
        </p>
      </div>

      {/* The thing they're signing */}
      <div className="rounded-lg border border-border p-5">
        <p className="text-lg">
          If the vote passes, Cogni will{" "}
          <span className="font-semibold">{params.action}</span> this pull
          request.
        </p>
      </div>

      {/* CTA */}
      <ProposalCta
        isConnected={isConnected}
        isCorrectChain={isCorrectChain}
        isPending={isPending}
        chainName={getChainName(params.chainId)}
        onSwitch={() => switchChain?.({ chainId: requiredChainId })}
        onSubmit={createProposal}
      />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Failed</AlertTitle>
          <AlertDescription>
            {error.message?.includes("User rejected")
              ? "Transaction cancelled."
              : error.message?.includes("insufficient funds")
                ? "Insufficient funds for gas."
                : (error.message ?? "Unknown error")}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProposalCta({
  isConnected,
  isCorrectChain,
  isPending,
  chainName,
  onSwitch,
  onSubmit,
}: {
  isConnected: boolean;
  isCorrectChain: boolean;
  isPending: boolean;
  chainName: string;
  onSwitch: () => void;
  onSubmit: () => void;
}) {
  if (!isConnected) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          Connect a wallet on {chainName} to continue.
        </p>
        <WalletConnectButton />
      </div>
    );
  }

  if (!isCorrectChain) {
    return (
      <Button variant="outline" onClick={onSwitch}>
        Switch to {chainName}
      </Button>
    );
  }

  return (
    <Button onClick={onSubmit} disabled={isPending}>
      {isPending ? "Confirm in wallet..." : "Create Proposal"}
    </Button>
  );
}

function SuccessView({
  proposalsUrl,
  prUrl,
  prNumber,
}: {
  proposalsUrl: string | null;
  prUrl: string;
  prNumber: string;
}) {
  return (
    <div className="flex flex-col items-center gap-6 py-12 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-success/10">
        <span className="text-3xl text-success" aria-hidden="true">
          &#x2713;
        </span>
      </div>

      <div className="space-y-1">
        <h1 className="font-bold text-2xl tracking-tight">Proposal Created</h1>
        <p className="text-muted-foreground">
          DAO members can now vote on this proposal.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        {proposalsUrl && (
          <Button asChild>
            <a href={proposalsUrl} target="_blank" rel="noopener noreferrer">
              Vote on Aragon
            </a>
          </Button>
        )}
        <Button variant="outline" asChild>
          <a href={prUrl} target="_blank" rel="noopener noreferrer">
            Back to PR #{prNumber}
          </a>
        </Button>
      </div>
    </div>
  );
}
