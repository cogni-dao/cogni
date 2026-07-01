"use client";

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/propose/publish-epoch/publish-epoch.client`
 * Purpose: Admin wallet surface for the publish-epoch distribution flow (story.5021 Walk, P4).
 *   Turns a FINALIZED, admin-signed epoch into an on-chain distribution: build (server) → deploy a
 *   stock MerkleDistributor (wallet) → DAO mint proposal with EARLY-EXECUTE (wallet) → persist the
 *   distributor + funding tx (server). No central wallet ever custodies tokens — the DAO mints
 *   straight into the distributor.
 * Scope: Client orchestration only. Mirrors the propose/merge wallet skeleton but FIXES the vote
 *   params (voteOption=Yes + tryEarlyExecution=true) so the proposal mints atomically. Reads/parses
 *   the authoritative proposalId from the ProposalCreated event (NOT the simulate return — OSx 1.4).
 * Invariants:
 *   - PUBLISH_EARLY_EXECUTE: createProposal is submitted with voteOption=Yes (2) + tryEarlyExecution=true.
 *   - PUBLISH_SOLO_SCOPE: atomic early-execute only holds for a SOLO, self-delegated DAO (the operator
 *     holds 100% of supply and is self-delegated). A multi-holder DAO needs a real vote + a later
 *     execute() — OUT OF SCOPE for V0 Walk; surfaced in the UI copy below.
 *   - PUBLISH_NO_CENTRAL_CUSTODY: the mint action targets token.mint(distributor, amount); tokens never
 *     touch a treasury/operator wallet.
 *   - PUBLISH_PROPOSAL_ID_FROM_EVENT: proposalId is parsed from ProposalCreated, never trusted from a call return.
 *   - PUBLISH_FROZEN_ROOT: the distributor is deployed against the server-built merkle root unchanged.
 * Side-effects: server fetches (build + persist) + blockchain writes (deploy + createProposal) via wallet signing.
 * Links: ../merge/merge-proposal.client.tsx (skeleton), nodes/operator/.../publish-epoch/route.ts,
 *   spikes/walk-p4-mint-into-distributor/REPORT.md, src/features/setup/hooks/useDAOFormation.ts (deploy pattern)
 * @public
 */

import {
  MERKLE_DISTRIBUTOR_ABI,
  MERKLE_DISTRIBUTOR_BYTECODE,
} from "@cogni/cogni-contracts";
import { GOVERNANCE_ERC20_ABI } from "@cogni/node-shared";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { decodeEventLog, encodeFunctionData } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  WalletConnectButton,
} from "@/components";
import { TOKEN_VOTING_ABI } from "@/features/governance/lib/proposal-abis";
import { getChainName } from "@/features/governance/lib/proposal-utils";

// enum IMajorityVoting.VoteOption { None=0, Abstain=1, Yes=2, No=3 }
const VOTE_YES = 2;

interface BuildResult {
  epochId: string;
  onchain: {
    chainId: number;
    dao: `0x${string}`;
    token: `0x${string}`;
    plugin: `0x${string}`;
  };
  distribution: {
    distributionId: string;
    merkleRoot: `0x${string}`;
    distributionAmount: string;
    totalAllocated: string;
    leafCount: number;
  };
  blockers: { code: string; message: string }[];
  unresolvedClaimantKeys: string[];
}

type Phase =
  | "idle"
  | "building"
  | "ready"
  | "deploying"
  | "proposing"
  | "persisting"
  | "done"
  | "error";

interface PublishParams {
  /** Node id or slug whose epoch is being published. */
  node: string;
  /** Decimal epoch id. */
  epochId: string;
}

function parsePublishParams(sp: URLSearchParams): PublishParams | null {
  const node = sp.get("node");
  const epochId = sp.get("epochId");
  if (!node || !epochId || !/^\d+$/.test(epochId)) return null;
  return { node, epochId };
}

export function PublishEpoch() {
  const searchParams = useSearchParams();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const client = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { switchChain } = useSwitchChain();

  const params = useMemo(
    () => parsePublishParams(searchParams),
    [searchParams]
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [distributor, setDistributor] = useState<`0x${string}` | null>(null);
  const [fundingTx, setFundingTx] = useState<`0x${string}` | null>(null);

  if (!params) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Alert variant="destructive" className="max-w-md">
          <AlertTitle>Invalid Link</AlertTitle>
          <AlertDescription>
            Missing required URL parameters (node, epochId).
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const requiredChainId = build?.onchain.chainId ?? chainId;
  const isCorrectChain = chainId === requiredChainId;

  // ── Step 1: build the distribution (server) ──────────────────────────────
  const doBuild = async () => {
    setError(null);
    setPhase("building");
    try {
      const res = await fetch(
        `/api/v1/nodes/${encodeURIComponent(params.node)}/publish-epoch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ epochId: params.epochId }),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(
          json?.reason ?? json?.error ?? `build failed (${res.status})`
        );
      }
      setBuild(json as BuildResult);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "build failed");
      setPhase("error");
    }
  };

  // ── Steps 2–4: deploy distributor → DAO mint proposal → persist ──────────
  const doPublish = async () => {
    if (!client || !walletClient || !build || !isCorrectChain) return;
    setError(null);

    try {
      // STEP 2: deploy the STOCK MerkleDistributor(token, merkleRoot).
      setPhase("deploying");
      const deployHash = await walletClient.deployContract({
        abi: MERKLE_DISTRIBUTOR_ABI,
        bytecode: MERKLE_DISTRIBUTOR_BYTECODE as `0x${string}`,
        args: [build.onchain.token, build.distribution.merkleRoot],
      });
      const deployRcpt = await client.waitForTransactionReceipt({
        hash: deployHash,
      });
      const deployed = deployRcpt.contractAddress;
      if (!deployed) throw new Error("distributor deploy returned no address");
      setDistributor(deployed);

      // STEP 3: DAO mint proposal — token.mint(distributor, amount), submitted
      // with voteOption=Yes + tryEarlyExecution=true so it MINTS in the same tx.
      setPhase("proposing");
      const mintCalldata = encodeFunctionData({
        abi: GOVERNANCE_ERC20_ABI,
        functionName: "mint",
        args: [deployed, BigInt(build.distribution.distributionAmount)],
      });
      const actions = [
        { to: build.onchain.token, value: 0n, data: mintCalldata },
      ];

      // startDate=0 => "now" (early-execute needs voting open immediately).
      const now = (await client.getBlock()).timestamp;
      const startDate = 0n;
      const endDate = now + 7200n; // > minDuration (3600s)
      const proposalArgs: [
        `0x${string}`,
        typeof actions,
        bigint,
        bigint,
        bigint,
        number,
        boolean,
      ] = ["0x", actions, 0n, startDate, endDate, VOTE_YES, true];

      const propHash = await walletClient.writeContract({
        address: build.onchain.plugin,
        abi: TOKEN_VOTING_ABI,
        functionName: "createProposal",
        args: proposalArgs,
      });
      const propRcpt = await client.waitForTransactionReceipt({
        hash: propHash,
      });
      if (propRcpt.status !== "success") {
        throw new Error("createProposal tx reverted");
      }
      setFundingTx(propHash);

      // PUBLISH_PROPOSAL_ID_FROM_EVENT: parse the authoritative id from the
      // ProposalCreated event (OSx 1.4 — the call return is wrong).
      let proposalId: bigint | undefined;
      for (const lg of propRcpt.logs) {
        if (lg.address.toLowerCase() !== build.onchain.plugin.toLowerCase())
          continue;
        try {
          const ev = decodeEventLog({
            abi: TOKEN_VOTING_ABI,
            data: lg.data,
            topics: lg.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          if (ev.eventName === "ProposalCreated") {
            proposalId = (ev.args as { proposalId: bigint }).proposalId;
            break;
          }
        } catch {
          // not the event we want
        }
      }
      if (proposalId === undefined) {
        throw new Error(
          "could not parse proposalId from ProposalCreated event"
        );
      }

      // Confirm the proposal EARLY-EXECUTED (executed=true) in the same tx.
      const proposal = await client.readContract({
        address: build.onchain.plugin,
        abi: TOKEN_VOTING_ABI,
        functionName: "getProposal",
        args: [proposalId],
      });
      const executed = (proposal as readonly unknown[])[1] as boolean;
      if (!executed) {
        throw new Error(
          "proposal did not early-execute — this DAO may have >1 holder or an undelegated proposer (multi-holder is out of scope for the V0 solo flow)"
        );
      }

      // STEP 4: persist {distributor, fundingTx} to the manifest (server).
      setPhase("persisting");
      const persistRes = await fetch(
        `/api/v1/nodes/${encodeURIComponent(params.node)}/publish-epoch/distributor`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            epochId: build.epochId,
            distributorAddress: deployed,
            fundingTx: propHash,
          }),
        }
      );
      const persistJson = await persistRes.json();
      if (!persistRes.ok) {
        throw new Error(
          persistJson?.reason ??
            persistJson?.error ??
            `persist failed (${persistRes.status})`
        );
      }

      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "publish failed");
      setPhase("error");
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (phase === "done") {
    return <SuccessView distributor={distributor} fundingTx={fundingTx} />;
  }

  const busy =
    phase === "building" ||
    phase === "deploying" ||
    phase === "proposing" ||
    phase === "persisting";

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
          Cogni governance · {getChainName(requiredChainId)}
        </p>
        <h1 className="font-bold text-3xl tracking-tight">
          Publish epoch {params.epochId}
        </h1>
        <p className="text-muted-foreground">
          Deploy a token distributor and have the DAO mint this epoch's tokens
          straight into it — no central wallet.
        </p>
      </div>

      <div className="rounded-lg border border-border p-5 text-sm">
        <p className="text-muted-foreground">
          Solo-DAO scope: this atomic mint-on-propose only works while one
          self-delegated holder owns 100% of voting power (the operator). A
          multi-holder DAO needs a real vote and a later execute — not supported
          here yet.
        </p>
      </div>

      {build && (
        <div className="rounded-lg border border-border p-5 text-sm">
          <dl className="grid grid-cols-2 gap-y-1">
            <dt className="text-muted-foreground">Merkle root</dt>
            <dd className="truncate font-mono">
              {build.distribution.merkleRoot}
            </dd>
            <dt className="text-muted-foreground">Leaves</dt>
            <dd>{build.distribution.leafCount}</dd>
            <dt className="text-muted-foreground">Mint amount</dt>
            <dd className="font-mono">
              {build.distribution.distributionAmount}
            </dd>
          </dl>
          {build.blockers.length > 0 && (
            <p className="mt-3 text-warning">
              {build.blockers.map((b) => b.message).join(" ")}
            </p>
          )}
        </div>
      )}

      <PublishCta
        isConnected={isConnected}
        isCorrectChain={isCorrectChain}
        phase={phase}
        busy={busy}
        hasBuild={Boolean(build)}
        chainName={getChainName(requiredChainId)}
        onSwitch={() => switchChain?.({ chainId: requiredChainId })}
        onBuild={doBuild}
        onPublish={doPublish}
      />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Failed</AlertTitle>
          <AlertDescription>
            {error.includes("User rejected") ? "Transaction cancelled." : error}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function PublishCta({
  isConnected,
  isCorrectChain,
  phase,
  busy,
  hasBuild,
  chainName,
  onSwitch,
  onBuild,
  onPublish,
}: {
  isConnected: boolean;
  isCorrectChain: boolean;
  phase: Phase;
  busy: boolean;
  hasBuild: boolean;
  chainName: string;
  onSwitch: () => void;
  onBuild: () => void;
  onPublish: () => void;
}) {
  if (!hasBuild) {
    return (
      <Button onClick={onBuild} disabled={busy}>
        {phase === "building"
          ? "Building distribution..."
          : "Build distribution"}
      </Button>
    );
  }

  if (!isConnected) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          Connect a wallet on {chainName} to publish.
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

  const label =
    phase === "deploying"
      ? "Deploying distributor..."
      : phase === "proposing"
        ? "Confirm mint in wallet..."
        : phase === "persisting"
          ? "Recording distributor..."
          : "Deploy + mint into distributor";

  return (
    <Button onClick={onPublish} disabled={busy}>
      {label}
    </Button>
  );
}

function SuccessView({
  distributor,
  fundingTx,
}: {
  distributor: `0x${string}` | null;
  fundingTx: `0x${string}` | null;
}) {
  return (
    <div className="flex flex-col items-center gap-6 py-12 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-success/10">
        <span className="text-3xl text-success" aria-hidden="true">
          &#x2713;
        </span>
      </div>
      <div className="space-y-1">
        <h1 className="font-bold text-2xl tracking-tight">Epoch published</h1>
        <p className="text-muted-foreground">
          The DAO minted this epoch's tokens into the distributor. Contributors
          can now claim.
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-y-1 text-sm">
        {distributor && (
          <>
            <dt className="text-muted-foreground">Distributor</dt>
            <dd className="font-mono">{distributor}</dd>
          </>
        )}
        {fundingTx && (
          <>
            <dt className="text-muted-foreground">Funding (mint) tx</dt>
            <dd className="truncate font-mono">{fundingTx}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
