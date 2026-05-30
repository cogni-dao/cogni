// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/dao/DAOFormationPage.client`
 * Purpose: Client-side DAO formation page with form input and wallet-signed transaction flow.
 * Scope: Renders form for DAO config, triggers formation via useDAOFormation hook, shows dialog for progress. Does not contain transaction logic or state machine implementation.
 * Invariants: Form validation inline; initialHolder defaults to connected wallet address.
 * Side-effects: IO (useDAOFormation hook performs wallet transactions).
 * Links: docs/spec/node-formation.md
 * @public
 */

"use client";

import { Info } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { useAccount } from "wagmi";

import {
  Button,
  HintText,
  Input,
  PageContainer,
  SectionCard,
} from "@/components";
import { FormationFlowDialog } from "@/features/setup/components/FormationFlowDialog";
import { useDAOFormation } from "@/features/setup/hooks/useDAOFormation";
import type { NodeStatus } from "@/shared/db/nodes";

import { NodeStatusBar } from "../nodes/[id]/NodeStatusBar";

interface Props {
  readonly nodeStatus?: NodeStatus;
  readonly nodeRepoUrl?: string;
}

export function DAOFormationPageClient({
  nodeStatus,
  nodeRepoUrl,
}: Props): ReactElement {
  const { address: walletAddress } = useAccount();
  const formation = useDAOFormation();
  const searchParams = useSearchParams();
  const router = useRouter();
  const nodeId = searchParams?.get("nodeId") ?? null;
  const patchedRef = useRef(false);

  // Form state
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [initialHolder, setInitialHolder] = useState("");

  // Dialog state
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Derived validation
  const effectiveHolder = initialHolder || walletAddress || "";
  const isValidName = tokenName.length >= 1 && tokenName.length <= 50;
  const isValidSymbol =
    tokenSymbol.length >= 1 &&
    tokenSymbol.length <= 10 &&
    /^[A-Z0-9]+$/.test(tokenSymbol);
  const isValidHolder = isAddress(effectiveHolder);
  const canSubmit =
    isValidName && isValidSymbol && isValidHolder && formation.isSupported;

  // Phase checks
  const isIdle = formation.state.phase === "IDLE";
  const isInFlight =
    formation.state.phase !== "IDLE" &&
    formation.state.phase !== "SUCCESS" &&
    formation.state.phase !== "ERROR";
  const isTerminal =
    formation.state.phase === "SUCCESS" || formation.state.phase === "ERROR";

  const handleSubmit = () => {
    if (!canSubmit || !isIdle) return;

    formation.startFormation({
      tokenName,
      tokenSymbol,
      initialHolder: effectiveHolder as `0x${string}`,
    });
    setIsDialogOpen(true);
  };

  const handleDialogClose = () => {
    // If in-flight without txHash, allow cancel
    if (isInFlight && !formation.state.daoTxHash) {
      formation.reset();
      setIsDialogOpen(false);
      return;
    }
    // Otherwise just close (keep state for terminal or in-progress with tx)
    setIsDialogOpen(false);
  };

  const handleReset = () => {
    formation.reset();
    setIsDialogOpen(false);
  };

  // When invoked from the external-node wizard (`?nodeId=...`), persist the
  // formation result to the operator's node-registry row and redirect back to
  // the dashboard. No-op when nodeId is absent (legacy YAML-paste flow).
  useEffect(() => {
    if (!nodeId) return;
    if (formation.state.phase !== "SUCCESS") return;
    if (!formation.state.addresses) return;
    if (patchedRef.current) return;
    patchedRef.current = true;

    const addresses = formation.state.addresses;
    const daoTxHash = formation.state.daoTxHash;
    const signalTxHash = formation.state.signalTxHash;
    const signalBlockNumber = formation.state.signalBlockNumber;

    void (async () => {
      try {
        await fetch(`/api/v1/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: { type: "dao_verified" },
            daoAddress: addresses.dao,
            pluginAddress: addresses.plugin,
            signalAddress: addresses.signal,
            tokenAddress: addresses.token,
            daoTxHash,
            signalTxHash,
            signalBlockNumber,
          }),
        });
      } finally {
        router.push(`/setup/nodes/${nodeId}`);
      }
    })();
  }, [nodeId, formation.state, router]);

  const isNodeWizard = nodeId != null;

  return (
    <PageContainer maxWidth="lg">
      {nodeStatus ? (
        <SectionCard title={nodeRepoUrl ?? "Node setup"}>
          <NodeStatusBar status={nodeStatus} />
        </SectionCard>
      ) : null}

      <SectionCard title="Create DAO">
        {/* Token Name */}
        <div className="space-y-2">
          <label
            htmlFor="tokenName"
            className="font-medium text-foreground text-sm"
          >
            Token Name
          </label>
          <Input
            id="tokenName"
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder="e.g., Cogni Governance"
            disabled={!isIdle}
          />
          {tokenName && !isValidName && (
            <p className="text-destructive text-sm">
              Token name must be 1-50 characters
            </p>
          )}
        </div>

        {/* Token Symbol */}
        <div className="space-y-2">
          <label
            htmlFor="tokenSymbol"
            className="font-medium text-foreground text-sm"
          >
            Token Symbol
          </label>
          <Input
            id="tokenSymbol"
            value={tokenSymbol}
            onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
            placeholder="e.g., COGNI"
            disabled={!isIdle}
          />
          {tokenSymbol && !isValidSymbol && (
            <p className="text-destructive text-sm">
              Symbol must be 1-10 uppercase letters/numbers
            </p>
          )}
        </div>

        {/* Initial Holder */}
        <div className="space-y-2">
          <label
            htmlFor="initialHolder"
            className="font-medium text-foreground text-sm"
          >
            Initial Token Holder
          </label>
          <Input
            id="initialHolder"
            value={initialHolder}
            onChange={(e) => setInitialHolder(e.target.value)}
            placeholder={walletAddress || "0x..."}
            disabled={!isIdle}
          />
          <p className="text-muted-foreground text-sm">
            Defaults to your connected wallet if left empty
          </p>
          {initialHolder && !isValidHolder && (
            <p className="text-destructive text-sm">Invalid Ethereum address</p>
          )}
        </div>

        {/* Submit Button */}
        <Button
          onClick={handleSubmit}
          disabled={!canSubmit || !isIdle}
          className="w-full"
        >
          {isInFlight ? "Creating..." : "Create DAO"}
        </Button>

        {/* Chain Support Warning */}
        {!formation.isSupported && (
          <HintText icon={<Info size={16} />}>
            Please connect to Base or Sepolia to create a DAO
          </HintText>
        )}
      </SectionCard>

      {/* Formation Flow Dialog */}
      <FormationFlowDialog
        open={isDialogOpen}
        phase={formation.state.phase}
        daoTxHash={formation.state.daoTxHash}
        signalTxHash={formation.state.signalTxHash}
        errorMessage={formation.state.errorMessage}
        repoSpecYaml={isNodeWizard ? null : formation.state.repoSpecYaml}
        addresses={formation.state.addresses}
        tokenName={formation.state.config?.tokenName ?? null}
        isInFlight={isInFlight}
        isTerminal={isTerminal}
        onClose={handleDialogClose}
        onReset={handleReset}
      />
    </PageContainer>
  );
}
