// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/PaymentActivationStep.client`
 * Purpose: Wizard-native payment activation for an external node.
 * Scope: Renders node identity, repo-spec audit links, Split deployment, and durable completion
 *   content inside the same node setup wizard shell. The connected wallet signs the on-chain
 *   createSplit transaction; the operator wallet remains the Split controller.
 * Side-effects: IO (wagmi transaction, PATCH node row on success, clipboard)
 * Links: src/features/nodes/wizard/step-registry.tsx, src/app/api/v1/nodes/[id]/route.ts
 * @public
 */

"use client";

import { PUSH_SPLIT_V2o2_FACTORY_ADDRESS } from "@0xsplits/splits-sdk/constants";
import { splitV2o2FactoryAbi } from "@0xsplits/splits-sdk/constants/abi";
import {
  calculateSplitAllocations,
  numberToPpm,
  OPENROUTER_CRYPTO_FEE_PPM,
  SPLIT_TOTAL_ALLOCATION,
} from "@cogni/operator-wallet";
import {
  AlertTriangle,
  CheckCircle,
  Clipboard,
  ExternalLink,
  Info,
  Loader2,
  Wallet,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { decodeEventLog, getAddress } from "viem";
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { Button, HintText } from "@/components";

import { LaunchPackCopyButton } from "../LaunchPackCopyButton.client";
import { StepSection } from "../StepSection";
import type { WizardStepProps } from "../types";

/** Default payment activation economics: 95% provider top-up / 5% DAO margin. */
const DEFAULT_MARKUP_FACTOR = 1.10803324099723;
const DEFAULT_REVENUE_SHARE = 0;

type ActivationPhase =
  | "IDLE"
  | "DEPLOYING"
  | "AWAITING_CONFIRMATION"
  | "SUCCESS"
  | "ERROR";

function repoSpecHref(nodeRepoUrl: string | null): string | null {
  if (!nodeRepoUrl) return null;
  const base = nodeRepoUrl.replace(/\/$/, "");
  return `${base}/blob/main/.cogni/repo-spec.yaml`;
}

function formatPercent(allocation: bigint): string {
  return `${Number(allocation) / 1e4}%`;
}

function buildRepoSpecFragment(splitAddress: string): string {
  return `payments_in:
  credits_topup:
    provider: cogni-usdc-backend-v1
    receiving_address: "${splitAddress}"
    allowed_chains:
      - Base
    allowed_tokens:
      - USDC
    markup_factor: ${DEFAULT_MARKUP_FACTOR}
    revenue_share: ${DEFAULT_REVENUE_SHARE}

payments:
  status: active`;
}

function buildPrivySetupPrompt(input: {
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly nodeRepoUrl: string | null;
  readonly repoSpecUrl: string | null;
}): string {
  return `You are activating the operator wallet prerequisites for my Cogni node.

Node: ${input.nodeSlug}
Node id: ${input.nodeId}
Node repo: ${input.nodeRepoUrl ?? "open the node dashboard for the repo link"}
Repo spec: ${input.repoSpecUrl ?? ".cogni/repo-spec.yaml in the node repo"}

Goal: provision a node-owned Privy operator wallet, store its secrets for the node, write the public operator wallet address into .cogni/repo-spec.yaml and the operator node registry, then return me to the node dashboard so I can deploy the payment Split.

Human steps:
1. Open the Privy dashboard and create or select the dedicated operator-wallet app for this node.
2. Copy the app id, app secret, and wallet signing key into a local env file for the AI dev only. Do not paste secret values into chat.

AI dev steps:
1. Read docs/guides/operator-wallet-setup.md and docs/guides/secrets-add-new.md.
2. Add the node's PRIVY_APP_ID, PRIVY_APP_SECRET, and PRIVY_SIGNING_KEY to candidate-a secrets.
3. Provision or resolve the Privy-managed operator wallet.
4. Update .cogni/repo-spec.yaml with operator_wallet.address.
5. Ensure the operator node registry row has operator_wallet_address for this node.
6. Run the required checks and flight, then send the human back to the node dashboard.

Never log, commit, or paste secret values.`;
}

function buildCompletionPrompt(input: {
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly nodeRepoUrl: string | null;
  readonly repoSpecUrl: string | null;
  readonly splitAddress: string;
}): string {
  return `You are finishing payment activation for my Cogni node.

Node: ${input.nodeSlug}
Node id: ${input.nodeId}
Node repo: ${input.nodeRepoUrl ?? "open the node dashboard for the repo link"}
Repo spec: ${input.repoSpecUrl ?? ".cogni/repo-spec.yaml in the node repo"}
Split receiving address on Base: ${input.splitAddress}

Update the node repo's .cogni/repo-spec.yaml with:

${buildRepoSpecFragment(input.splitAddress)}

Then open a PR, run the Cogni CI/flight sequence, validate candidate-a, and report the live test URL. Do not change secrets in git.`;
}

function AddressRows({
  operatorWalletAddress,
  daoTreasuryAddress,
  operatorAllocation,
  treasuryAllocation,
}: {
  readonly operatorWalletAddress: string | null;
  readonly daoTreasuryAddress: string | null;
  readonly operatorAllocation: bigint;
  readonly treasuryAllocation: bigint;
}): ReactElement {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-4 text-sm">
      <p>
        <span className="font-medium">Operator wallet:</span>{" "}
        <code className="break-all text-xs">
          {operatorWalletAddress ?? "Missing"}
        </code>
      </p>
      <p>
        <span className="font-medium">DAO treasury:</span>{" "}
        <code className="break-all text-xs">
          {daoTreasuryAddress ?? "Missing"}
        </code>
      </p>
      <p className="text-muted-foreground">
        Split allocation: operator {formatPercent(operatorAllocation)} /
        treasury {formatPercent(treasuryAllocation)}
      </p>
    </div>
  );
}

export function PaymentActivationStep({ node }: WizardStepProps): ReactElement {
  const { address: walletAddress } = useAccount();
  const router = useRouter();
  const patchedRef = useRef(false);

  const [phase, setPhase] = useState<ActivationPhase>("IDLE");
  const [splitAddress, setSplitAddress] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<
    "setup" | "repo-spec" | "handoff" | null
  >(null);

  const {
    writeContract,
    data: txHash,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract();

  const { data: receipt, error: receiptError } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const hasOperator = !!node.operatorWalletAddress;
  const hasTreasury = !!node.daoAddress;
  const isReady = hasOperator && hasTreasury;
  const isInFlight = phase === "DEPLOYING" || phase === "AWAITING_CONFIRMATION";
  const canSubmit =
    isReady &&
    phase === "IDLE" &&
    node.status === "wallet_ready" &&
    !!walletAddress;
  const repoSpecUrl = repoSpecHref(node.nodeRepoUrl);
  const effectiveSplitAddress = splitAddress ?? node.splitAddress;
  const isComplete =
    phase === "SUCCESS" ||
    (node.status === "payments_ready" && !!effectiveSplitAddress);

  const { operatorAllocation, treasuryAllocation } = calculateSplitAllocations(
    numberToPpm(DEFAULT_MARKUP_FACTOR),
    numberToPpm(DEFAULT_REVENUE_SHARE),
    OPENROUTER_CRYPTO_FEE_PPM
  );

  const setupPrompt = useMemo(
    () =>
      buildPrivySetupPrompt({
        nodeId: node.id,
        nodeSlug: node.slug,
        nodeRepoUrl: node.nodeRepoUrl,
        repoSpecUrl,
      }),
    [node.id, node.slug, node.nodeRepoUrl, repoSpecUrl]
  );

  const completionPrompt = effectiveSplitAddress
    ? buildCompletionPrompt({
        nodeId: node.id,
        nodeSlug: node.slug,
        nodeRepoUrl: node.nodeRepoUrl,
        repoSpecUrl,
        splitAddress: effectiveSplitAddress,
      })
    : null;

  const repoSpecFragment = effectiveSplitAddress
    ? buildRepoSpecFragment(effectiveSplitAddress)
    : null;

  const handleDeploy = useCallback(() => {
    if (
      !canSubmit ||
      !walletAddress ||
      !node.operatorWalletAddress ||
      !node.daoAddress
    ) {
      return;
    }

    setPhase("DEPLOYING");
    setErrorMessage(null);
    setSplitAddress(null);

    const operator = getAddress(node.operatorWalletAddress) as Address;
    const treasury = getAddress(node.daoAddress) as Address;
    const entries = [
      { address: operator, allocation: operatorAllocation },
      { address: treasury, allocation: treasuryAllocation },
    ].sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );

    writeContract({
      address: getAddress(PUSH_SPLIT_V2o2_FACTORY_ADDRESS) as Address,
      abi: splitV2o2FactoryAbi,
      functionName: "createSplit",
      args: [
        {
          recipients: entries.map(
            (entry) => entry.address
          ) as readonly Address[],
          allocations: entries.map(
            (entry) => entry.allocation
          ) as readonly bigint[],
          totalAllocation: SPLIT_TOTAL_ALLOCATION,
          distributionIncentive: 0,
        },
        operator,
        walletAddress as Address,
      ],
    });
  }, [
    canSubmit,
    walletAddress,
    node.operatorWalletAddress,
    node.daoAddress,
    operatorAllocation,
    treasuryAllocation,
    writeContract,
  ]);

  useEffect(() => {
    if (txHash && phase === "DEPLOYING") {
      setPhase("AWAITING_CONFIRMATION");
    }
  }, [txHash, phase]);

  useEffect(() => {
    if (receipt && phase === "AWAITING_CONFIRMATION") {
      let deployedSplitAddress: string | undefined;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: splitV2o2FactoryAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "SplitCreated") {
            deployedSplitAddress = (decoded.args as { split: Address }).split;
            break;
          }
        } catch {
          // Ignore unrelated logs in the transaction receipt.
        }
      }

      if (deployedSplitAddress) {
        setSplitAddress(deployedSplitAddress);
        setPhase("SUCCESS");
      } else {
        setErrorMessage(
          "Could not extract the Split address from the receipt."
        );
        setPhase("ERROR");
      }
    }
  }, [receipt, phase]);

  useEffect(() => {
    if (writeError && phase === "DEPLOYING") {
      setErrorMessage(writeError.message || "Split deployment failed.");
      setPhase("ERROR");
    }
  }, [writeError, phase]);

  useEffect(() => {
    if (receiptError && phase === "AWAITING_CONFIRMATION") {
      setErrorMessage(
        receiptError.message || "Transaction confirmation failed."
      );
      setPhase("ERROR");
    }
  }, [receiptError, phase]);

  useEffect(() => {
    if (phase !== "SUCCESS" || !splitAddress || patchedRef.current) return;
    patchedRef.current = true;

    void (async () => {
      try {
        const response = await fetch(`/api/v1/nodes/${node.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: { type: "payments_configured" },
            splitAddress,
            splitTxHash: txHash,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(body || `HTTP ${response.status}`);
        }

        router.refresh();
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        setErrorMessage(
          `Split deployed at ${splitAddress}, but the node dashboard update failed: ${details}`
        );
        setPhase("ERROR");
      }
    })();
  }, [node.id, phase, router, splitAddress, txHash]);

  const copyText = async (
    text: string,
    label: "setup" | "repo-spec" | "handoff"
  ) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 2000);
  };

  const handleReset = () => {
    resetWrite();
    setPhase("IDLE");
    setSplitAddress(null);
    setErrorMessage(null);
  };

  return (
    <StepSection title={isComplete ? "Payments ready" : "Activate payments"}>
      <div className="space-y-5 text-sm">
        <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-4 sm:grid-cols-2">
          <p>
            <span className="block text-muted-foreground text-xs">Node</span>
            <span className="font-medium">{node.slug}</span>
          </p>
          <p>
            <span className="block text-muted-foreground text-xs">Node ID</span>
            <code className="break-all text-xs">{node.id}</code>
          </p>
          {node.nodeRepoUrl ? (
            <a
              href={node.nodeRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-primary hover:underline"
            >
              Node repo
              <ExternalLink className="size-3.5" />
            </a>
          ) : (
            <span className="text-muted-foreground">Node repo unavailable</span>
          )}
          {repoSpecUrl ? (
            <a
              href={repoSpecUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-primary hover:underline"
            >
              .cogni/repo-spec.yaml
              <ExternalLink className="size-3.5" />
            </a>
          ) : (
            <span className="text-muted-foreground">
              Repo-spec link unavailable
            </span>
          )}
        </div>

        {!isReady ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div>
                <p className="font-medium text-foreground">
                  Payment prerequisites are not ready yet
                </p>
                <p>
                  The operator must know this node's DAO treasury and node-owned
                  operator wallet before it can deploy a Split.
                </p>
              </div>
            </div>

            <AddressRows
              operatorWalletAddress={node.operatorWalletAddress}
              daoTreasuryAddress={node.daoAddress}
              operatorAllocation={operatorAllocation}
              treasuryAllocation={treasuryAllocation}
            />

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                onClick={() => copyText(setupPrompt, "setup")}
                className="gap-2"
              >
                {copied === "setup" ? (
                  <CheckCircle className="size-4" />
                ) : (
                  <Clipboard className="size-4" />
                )}
                {copied === "setup" ? "Copied" : "Copy AI-dev setup prompt"}
              </Button>
              <LaunchPackCopyButton nodeId={node.id} variant="secondary" />
            </div>
          </div>
        ) : null}

        {isReady && !isComplete ? (
          <div className="space-y-4">
            <HintText icon={<Info size={16} />}>
              The operator resolved these addresses from this node's registry
              row. The repo-spec link above is the audit trail; the user does
              not need to manually validate address text.
            </HintText>

            <AddressRows
              operatorWalletAddress={node.operatorWalletAddress}
              daoTreasuryAddress={node.daoAddress}
              operatorAllocation={operatorAllocation}
              treasuryAllocation={treasuryAllocation}
            />

            <div className="rounded-md border border-border bg-muted/30 p-4">
              <div className="flex items-start gap-3">
                <Wallet className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">What your wallet confirms</p>
                  <p className="text-muted-foreground">
                    One Base transaction deploys a 0xSplits contract. Your
                    wallet pays gas and is recorded as the creator; the node
                    operator wallet becomes the Split controller. This does not
                    make your wallet the node owner or treasury.
                  </p>
                </div>
              </div>
            </div>

            <Button
              type="button"
              onClick={handleDeploy}
              disabled={!canSubmit}
              className="w-full gap-2"
            >
              {isInFlight ? <Loader2 className="size-4 animate-spin" /> : null}
              {!walletAddress
                ? "Connect wallet to deploy Split"
                : "Deploy payment Split"}
            </Button>
          </div>
        ) : null}

        {isInFlight ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-muted-foreground">
              {phase === "DEPLOYING"
                ? "Confirm the Base transaction in your wallet."
                : "Waiting for the transaction to confirm on Base."}
            </p>
          </div>
        ) : null}

        {isComplete && effectiveSplitAddress ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2">
              <CheckCircle className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="font-medium">Payment Split is deployed</p>
                <p className="text-muted-foreground">
                  The operator row is ready. The node repo still needs the
                  payment config committed and flighted before users can test a
                  real top-up in the node app.
                </p>
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-border bg-muted/40 p-4">
              <p>
                <span className="font-medium">Split receiving address:</span>{" "}
                <code className="break-all text-xs">
                  {effectiveSplitAddress}
                </code>
              </p>
              {txHash ? (
                <p>
                  <span className="font-medium">Deployment tx:</span>{" "}
                  <code className="break-all text-xs">{txHash}</code>
                </p>
              ) : null}
            </div>

            {repoSpecFragment ? (
              <div className="rounded-md border border-border bg-muted/40 p-4">
                <p className="mb-2 font-medium">
                  Repo-spec block for the AI dev
                </p>
                <pre className="max-h-56 overflow-x-auto whitespace-pre-wrap break-words text-xs">
                  {repoSpecFragment}
                </pre>
              </div>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-2">
              {repoSpecFragment ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => copyText(repoSpecFragment, "repo-spec")}
                  className="gap-2"
                >
                  {copied === "repo-spec" ? (
                    <CheckCircle className="size-4" />
                  ) : (
                    <Clipboard className="size-4" />
                  )}
                  {copied === "repo-spec" ? "Copied" : "Copy repo-spec block"}
                </Button>
              ) : null}
              {completionPrompt ? (
                <Button
                  type="button"
                  onClick={() => copyText(completionPrompt, "handoff")}
                  className="gap-2"
                >
                  {copied === "handoff" ? (
                    <CheckCircle className="size-4" />
                  ) : (
                    <Clipboard className="size-4" />
                  )}
                  {copied === "handoff" ? "Copied" : "Copy AI-dev handoff"}
                </Button>
              ) : null}
            </div>

            <p className="text-muted-foreground">
              After the AI dev commits this to the node repo and the test
              deployment appears below, open the node app's credits or top-up
              page and make a small USDC test payment.
            </p>
          </div>
        ) : null}

        {phase === "ERROR" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="size-5" />
              <span className="font-medium">
                Payment activation hit an error
              </span>
            </div>
            <p className="text-muted-foreground">{errorMessage}</p>
            <Button
              type="button"
              variant="outline"
              onClick={handleReset}
              className="w-full"
            >
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </StepSection>
  );
}
