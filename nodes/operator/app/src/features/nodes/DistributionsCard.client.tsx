// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/DistributionsCard.client`
 * Purpose: Visible, owner-driven distribution-activation control — the UI surface for
 *   `POST /api/v1/nodes/[id]/activate-distributions`. R2: activation is an ADMIN-WALLET checkpoint
 *   (like payments activation). The owner connects their wallet, DEPLOYS the ONE stock 1inch
 *   CumulativeMerkleDrop(token) client-side, transfers ownership to the DAO, then the server verifies
 *   + records the distributor address into repo-spec via a one-file PR.
 * Scope: Renders a compact "Distributions" SectionCard. The deploy + transferOwnership are wallet
 *   txs signed by the connected admin (no server key ever fires an on-chain tx). Flow:
 *     1. Probe the activation route (empty POST). 428 needsDeploy ⇒ deploy required; already_deployed
 *        ⇒ surface the recorded address (IDEMPOTENT, no redeploy).
 *     2. Wallet: deployContract(CumulativeMerkleDrop, [token]) → transferOwnership(dao).
 *     3. POST { distributorAddress, distributorDeployTx } ⇒ server verifies token()/owner() + records.
 * Side-effects: IO (POST activate-distributions route, router.refresh) + blockchain writes (deploy +
 *   transferOwnership via wallet signing).
 * Invariants:
 *   - CLIENT_DEPLOYS_DISTRIBUTOR: the admin wallet deploys + transfers ownership; the server only
 *     verifies + records.
 *   - IDEMPOTENT: a recorded distributor is surfaced, never redeployed.
 * Links: src/app/api/v1/nodes/[id]/activate-distributions/route.ts, src/app/(app)/nodes/[id]/page.tsx,
 *   packages/cogni-contracts/src/cumulative-merkle-distributor
 * @public
 */

"use client";

import {
  CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
  CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE,
} from "@cogni/cogni-contracts";
import { ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";

import { Button, SectionCard, WalletConnectButton } from "@/components";

interface Props {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoSpecUrl: string | null;
  /** Node GovernanceERC20 token (constructor arg for the distributor). */
  readonly tokenAddress: string | null;
  /** DAO contract — distributor ownership is transferred here after deploy. */
  readonly daoAddress: string | null;
  /** Chain the token/DAO live on; the wallet must be on this chain to deploy. */
  readonly chainId: number | null;
}

type Result =
  | { kind: "pr_opened"; prUrl: string }
  | { kind: "no_changes" }
  | { kind: "already_deployed"; distributorAddress: string }
  | null;

type Phase =
  | "idle"
  | "probing"
  | "deploying"
  | "transferring"
  | "recording"
  | "done";

function readError(text: string): {
  error?: string;
  reason?: string;
  needsDeploy?: boolean;
  distributorAddress?: string;
  activation?: { status?: string; prUrl?: string };
} {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function DistributionsCard({
  nodeId,
  slug,
  repoSpecUrl,
  tokenAddress,
  daoAddress,
  chainId,
}: Props): ReactElement {
  const router = useRouter();
  const { isConnected } = useAccount();
  const walletChainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { switchChain } = useSwitchChain();

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);

  const busy = phase !== "idle" && phase !== "done";
  const onCorrectChain = chainId != null && walletChainId === chainId;

  const recordActivation = async (body: Record<string, unknown>) => {
    const response = await fetch(
      `/api/v1/nodes/${nodeId}/activate-distributions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const text = await response.text();
    return { response, parsed: readError(text), text };
  };

  const handleActivate = async () => {
    if (busy) {
      return;
    }
    setError(null);
    setResult(null);

    // Guard client-side prerequisites before spending gas.
    if (!tokenAddress || !daoAddress) {
      setError("node is missing token or DAO address");
      return;
    }
    if (!isConnected || !walletClient || !publicClient) {
      setError("connect an admin wallet to deploy the distributor");
      return;
    }
    if (chainId != null && !onCorrectChain) {
      setError(`switch your wallet to chain ${chainId}`);
      return;
    }

    try {
      // STEP 1 — probe: is a distributor already recorded (idempotent)?
      setPhase("probing");
      const probe = await recordActivation({});
      if (probe.parsed.distributorAddress && probe.response.ok) {
        setResult({
          kind: "already_deployed",
          distributorAddress: probe.parsed.distributorAddress,
        });
        setPhase("done");
        router.refresh();
        return;
      }
      // Anything other than "deploy required" (428) is a real error.
      if (!probe.response.ok && !probe.parsed.needsDeploy) {
        throw new Error(probe.parsed.error ?? `HTTP ${probe.response.status}`);
      }

      // STEP 2 — deploy the STOCK 1inch CumulativeMerkleDrop(token). owner = deployer.
      setPhase("deploying");
      const deployHash = await walletClient.deployContract({
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        bytecode: CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE as `0x${string}`,
        args: [tokenAddress as `0x${string}`],
      });
      const deployRcpt = await publicClient.waitForTransactionReceipt({
        hash: deployHash,
      });
      const distributor = deployRcpt.contractAddress;
      if (!distributor) {
        throw new Error("distributor deploy returned no address");
      }

      // STEP 3 — transferOwnership(distributor) → DAO, so DAO governance owns setMerkleRoot.
      setPhase("transferring");
      const transferHash = await walletClient.writeContract({
        address: distributor,
        abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        functionName: "transferOwnership",
        args: [daoAddress as `0x${string}`],
      });
      const transferRcpt = await publicClient.waitForTransactionReceipt({
        hash: transferHash,
      });
      if (transferRcpt.status !== "success") {
        throw new Error("transferOwnership reverted");
      }

      // STEP 4 — record: server verifies token()==token & owner()==DAO, writes repo-spec PR.
      setPhase("recording");
      const recorded = await recordActivation({
        distributorAddress: distributor,
        distributorDeployTx: deployHash,
      });
      if (!recorded.response.ok) {
        throw new Error(
          recorded.parsed.error ??
            recorded.parsed.reason ??
            `HTTP ${recorded.response.status}`
        );
      }
      const activation = recorded.parsed.activation;
      if (activation?.status === "pr_opened" && activation.prUrl) {
        setResult({ kind: "pr_opened", prUrl: activation.prUrl });
      } else {
        setResult({ kind: "no_changes" });
      }
      setPhase("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "activation failed");
      setPhase("idle");
    }
  };

  const phaseLabel: Record<Phase, string> = {
    idle: "Activate distributions",
    probing: "Checking…",
    deploying: "Deploying distributor…",
    transferring: "Transferring ownership to DAO…",
    recording: "Recording in repo-spec…",
    done: "Activate distributions",
  };

  return (
    <SectionCard
      title="Distributions"
      className="mx-auto mt-4 w-full max-w-2xl"
    >
      <p className="text-muted-foreground text-sm">
        Deploys the ONE cumulative token distributor for{" "}
        <span className="font-medium">{slug}</span> (stock 1inch
        CumulativeMerkleDrop), transfers its ownership to the DAO, and records
        its address in <code>.cogni/repo-spec.yaml</code>. Your admin wallet
        signs the deploy — no central wallet ever holds tokens. Epoch
        finalization reuses this ONE distributor for every epoch.
      </p>

      {result?.kind === "pr_opened" ? (
        <a
          href={result.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
        >
          Activation PR opened
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
      {result?.kind === "already_deployed" ? (
        <p className="text-muted-foreground text-sm">
          Distributor already deployed: <code>{result.distributorAddress}</code>{" "}
          — nothing to do.
        </p>
      ) : null}
      {result?.kind === "no_changes" ? (
        <p className="text-muted-foreground text-sm">
          Distributions already active — nothing to change.
        </p>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <WalletConnectButton />
        {isConnected && chainId != null && !onCorrectChain ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => switchChain({ chainId })}
          >
            Switch to chain {chainId}
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={handleActivate}
          disabled={busy || !isConnected || !onCorrectChain}
          className="gap-2"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {phaseLabel[phase]}
        </Button>
        {repoSpecUrl ? (
          <a
            href={repoSpecUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground text-sm hover:text-foreground"
          >
            View repo-spec
          </a>
        ) : null}
      </div>
    </SectionCard>
  );
}
