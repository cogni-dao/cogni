// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/DaoStep.client`
 * Purpose: Inline DAO formation step — form + in-place phase checklist (no modal).
 * Scope: Reuses the untouched `useDAOFormation` hook + reducer. On success it stops the wagmi
 *   receipt polling (reset), shows an optimistic "advancing" state, persists the verified result,
 *   then refreshes so the shell morphs forward — never parking on a frozen checklist.
 * Invariants: Wallet signing is the only external popup; all wizard progress is inline.
 * Side-effects: IO (useDAOFormation wallet txs, PATCH /api/v1/nodes/:id), React state
 * Links: src/features/setup/hooks/useDAOFormation.ts, src/features/nodes/wizard/PhaseList.tsx
 * @public
 */

"use client";

import { getTransactionExplorerUrl, toUiError } from "@cogni/node-shared";
import { CheckCircle2, ExternalLink, Info, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { useAccount, useChainId } from "wagmi";

import { Button, HintText, Input } from "@/components";
import { useDAOFormation } from "@/features/setup/hooks/useDAOFormation";

import { type Phase, PhaseList, type PhaseState } from "../PhaseList";
import { StepSection } from "../StepSection";
import type { WizardStepProps } from "../types";

/** Derive a valid token symbol (≤10 uppercase alphanumerics) from the node slug. */
function symbolFromSlug(slug: string): string {
  return slug
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
}

const DAO_PHASES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "PREFLIGHT", label: "Checking network" },
  { key: "CREATING_DAO", label: "Create DAO (confirm in wallet)" },
  { key: "AWAITING_DAO_CONFIRMATION", label: "Confirming DAO transaction" },
  { key: "DEPLOYING_SIGNAL", label: "Deploy signal (confirm in wallet)" },
  {
    key: "AWAITING_SIGNAL_CONFIRMATION",
    label: "Confirming signal transaction",
  },
  { key: "VERIFYING", label: "Verifying on-chain results" },
];

const PHASE_ORDER = DAO_PHASES.map((p) => p.key);

function phaseStateFor(currentPhase: string, phaseKey: string): PhaseState {
  const currentIdx =
    currentPhase === "SUCCESS"
      ? PHASE_ORDER.length
      : PHASE_ORDER.indexOf(currentPhase);
  const thisIdx = PHASE_ORDER.indexOf(phaseKey);
  if (thisIdx < currentIdx) return "done";
  if (thisIdx === currentIdx) return "active";
  return "pending";
}

export function DaoStep({ node }: WizardStepProps): ReactElement {
  const { address: walletAddress } = useAccount();
  const chainId = useChainId();
  const formation = useDAOFormation();
  const { reset: resetFormation } = formation;
  const router = useRouter();
  const patchedRef = useRef(false);

  const [tokenName, setTokenName] = useState(node.slug);
  const [tokenSymbol, setTokenSymbol] = useState(symbolFromSlug(node.slug));
  const [initialHolder, setInitialHolder] = useState("");
  const [patchError, setPatchError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const effectiveHolder = initialHolder || walletAddress || "";
  const isValidName = tokenName.length >= 1 && tokenName.length <= 50;
  const isValidSymbol =
    tokenSymbol.length >= 1 &&
    tokenSymbol.length <= 10 &&
    /^[A-Z0-9]+$/.test(tokenSymbol);
  const isValidHolder = isAddress(effectiveHolder);
  const canSubmit =
    isValidName && isValidSymbol && isValidHolder && formation.isSupported;

  const phase = formation.state.phase;
  const isIdle = phase === "IDLE";
  const isError = phase === "ERROR";
  const isInFlight = !isIdle && phase !== "SUCCESS" && phase !== "ERROR";

  const displayTxHash =
    formation.state.signalTxHash ?? formation.state.daoTxHash;
  const explorerUrl = displayTxHash
    ? getTransactionExplorerUrl(chainId, displayTxHash)
    : null;

  const handleSubmit = () => {
    if (!canSubmit || !isIdle) return;
    setPatchError(null);
    formation.startFormation({
      tokenName,
      tokenSymbol,
      initialHolder: effectiveHolder as `0x${string}`,
    });
  };

  // On success: persist the verified result, stop wagmi receipt polling, then
  // refresh so the shell advances. `advancing` keeps the UI on a clear "setting
  // up" state (never the frozen checklist) and prevents the form from flashing
  // back when reset() returns the reducer to IDLE.
  useEffect(() => {
    if (phase !== "SUCCESS") return;
    if (!formation.state.addresses) return;
    if (patchedRef.current) return;
    patchedRef.current = true;
    setAdvancing(true);

    const { addresses, daoTxHash, signalTxHash, signalBlockNumber } =
      formation.state;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/nodes/${node.id}`, {
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
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setPatchError(body?.reason ?? body?.error ?? `HTTP ${res.status}`);
          setAdvancing(false);
          patchedRef.current = false;
          return;
        }
        resetFormation(); // stop wagmi receipt polling before the refresh
        router.refresh();
      } catch (e) {
        setPatchError(e instanceof Error ? e.message : "request failed");
        setAdvancing(false);
        patchedRef.current = false;
      }
    })();
  }, [phase, formation.state, node.id, router, resetFormation]);

  if (advancing) {
    return (
      <StepSection title="DAO created">
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <CheckCircle2 className="size-10 text-success" />
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            Setting up your app…
          </div>
        </div>
      </StepSection>
    );
  }

  if (isInFlight || phase === "SUCCESS") {
    const phases: Phase[] = DAO_PHASES.map((p) => ({
      label: p.label,
      state: phaseStateFor(phase, p.key),
    }));
    return (
      <StepSection title="Create DAO">
        <PhaseList phases={phases} />
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary text-sm hover:underline"
          >
            <span>View transaction</span>
            <ExternalLink className="size-4" />
          </a>
        )}
        <p className="text-muted-foreground text-xs">
          Keep this tab open — confirm each wallet prompt as it appears.
        </p>
      </StepSection>
    );
  }

  return (
    <StepSection title="Create DAO">
      <p className="text-muted-foreground text-sm">
        Prefilled from your node name — edit if you like.
      </p>

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
        />
        {tokenName && !isValidName && (
          <p className="text-destructive text-sm">
            Token name must be 1-50 characters
          </p>
        )}
      </div>

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
        />
        {tokenSymbol && !isValidSymbol && (
          <p className="text-destructive text-sm">
            Symbol must be 1-10 uppercase letters/numbers
          </p>
        )}
      </div>

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
        />
        <p className="text-muted-foreground text-sm">
          Defaults to your connected wallet if left empty
        </p>
        {initialHolder && !isValidHolder && (
          <p className="text-destructive text-sm">Invalid Ethereum address</p>
        )}
      </div>

      {isError && formation.state.errorMessage ? (
        <p className="text-destructive text-sm">
          {toUiError(formation.state.errorMessage).message}
        </p>
      ) : null}

      <Button onClick={handleSubmit} disabled={!canSubmit} className="w-full">
        {isError ? "Try again" : "Create DAO"}
      </Button>

      {!formation.isSupported && (
        <HintText icon={<Info size={16} />}>
          Connect to Base or Sepolia to create a DAO
        </HintText>
      )}

      {patchError ? (
        <p className="text-destructive text-sm">{patchError}</p>
      ) : null}
    </StepSection>
  );
}
