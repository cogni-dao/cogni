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

// biome-ignore-all lint/nursery/useSortedClasses: Prettier owns Tailwind class ordering for this TSX file.

"use client";

import {
  DAO_TOKEN_SUPPLY_DEFAULT_WHOLE,
  DAO_TOKEN_SUPPLY_MAX_WHOLE,
  DAO_TOKEN_SUPPLY_MIN_WHOLE,
  DAO_TOKENOMICS_TEMPLATES,
  type DaoTokenomicsTemplateId,
  DEFAULT_DAO_TOKENOMICS_TEMPLATE_ID,
  parseDaoGenesisMintUnits,
  parseDaoTokenSupplyUnits,
  resolveDaoTokenomics,
} from "@cogni/aragon-osx";
import { getTransactionExplorerUrl, toUiError } from "@cogni/node-shared";
import { CheckCircle2, ExternalLink, Info, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { isAddress } from "viem";
import { useAccount, useChainId } from "wagmi";

import { Button, HintText, Input, PieChart } from "@/components";
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
const TOKEN_SUPPLY_FORMATTER = new Intl.NumberFormat("en-US");
const TOKENOMICS_CHART_COLORS = [
  "hsl(var(--chart-1) / 0.75)",
  "hsl(var(--chart-3) / 0.75)",
  "hsl(var(--chart-4) / 0.75)",
  "hsl(var(--chart-5) / 0.75)",
] as const;

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
  const [tokenPolicySupply, setTokenPolicySupply] = useState(
    DAO_TOKEN_SUPPLY_DEFAULT_WHOLE
  );
  const [tokenomicsTemplateId, setTokenomicsTemplateId] =
    useState<DaoTokenomicsTemplateId>(DEFAULT_DAO_TOKENOMICS_TEMPLATE_ID);
  const [initialHolder, setInitialHolder] = useState("");
  const [patchError, setPatchError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const resolvedTokenomics = useMemo(() => {
    if (
      !Number.isSafeInteger(tokenPolicySupply) ||
      tokenPolicySupply < DAO_TOKEN_SUPPLY_MIN_WHOLE ||
      tokenPolicySupply > DAO_TOKEN_SUPPLY_MAX_WHOLE
    ) {
      return null;
    }
    return resolveDaoTokenomics({
      templateId: tokenomicsTemplateId,
      policySupplyWholeTokens: tokenPolicySupply,
    });
  }, [tokenomicsTemplateId, tokenPolicySupply]);
  const tokenomicsChart = useMemo(() => {
    if (!resolvedTokenomics) {
      return { chartData: [], chartConfig: {}, legendEntries: [] };
    }
    const chartConfig: Record<string, { label: string; color: string }> = {};
    const chartData: { name: string; value: number; fill: string }[] = [];
    const legendEntries: {
      label: string;
      value: number;
      color: string;
      mintedAtFormation: boolean;
    }[] = [];

    for (const [index, slice] of resolvedTokenomics.slices.entries()) {
      const key = slice.role;
      const color = TOKENOMICS_CHART_COLORS[
        index % TOKENOMICS_CHART_COLORS.length
      ] as string;
      chartConfig[key] = { label: slice.label, color };
      chartData.push({
        name: key,
        value: slice.wholeTokens,
        fill: `var(--color-${key})`,
      });
      legendEntries.push({
        label: slice.label,
        value: slice.wholeTokens,
        color,
        mintedAtFormation: slice.mintedAtFormation,
      });
    }

    return { chartData, chartConfig, legendEntries };
  }, [resolvedTokenomics]);

  const effectiveHolder = initialHolder || walletAddress || "";
  const isValidName = tokenName.length >= 1 && tokenName.length <= 50;
  const isValidSymbol =
    tokenSymbol.length >= 1 &&
    tokenSymbol.length <= 10 &&
    /^[A-Z0-9]+$/.test(tokenSymbol);
  const isValidSupply =
    Number.isSafeInteger(tokenPolicySupply) &&
    tokenPolicySupply >= DAO_TOKEN_SUPPLY_MIN_WHOLE &&
    tokenPolicySupply <= DAO_TOKEN_SUPPLY_MAX_WHOLE &&
    resolvedTokenomics != null;
  const isValidHolder = isAddress(effectiveHolder);
  const canSubmit =
    isValidName &&
    isValidSymbol &&
    isValidSupply &&
    isValidHolder &&
    formation.isSupported;

  const phase = formation.state.phase;
  const isIdle = phase === "IDLE";
  const isError = phase === "ERROR";
  const canRetry = isError && formation.state.recoverable;
  const isInFlight = !isIdle && phase !== "SUCCESS" && phase !== "ERROR";

  const displayTxHash =
    formation.state.signalTxHash ?? formation.state.daoTxHash;
  const explorerUrl = displayTxHash
    ? getTransactionExplorerUrl(chainId, displayTxHash)
    : null;

  const handleSubmit = () => {
    if (!canSubmit || (!isIdle && !canRetry)) return;
    setPatchError(null);
    if (canRetry) {
      resetFormation();
    }
    if (!resolvedTokenomics) return;
    try {
      formation.startFormation({
        nodeId: node.id,
        tokenName,
        tokenSymbol,
        tokenomicsTemplateId,
        // Policy supply uses the supply parser (1000-token floor); the genesis
        // MINT amount uses its own parser — the "solo_one_token" template mints
        // exactly 1 token, which the supply floor wrongly rejected.
        policySupplyUnits: parseDaoTokenSupplyUnits(tokenPolicySupply),
        genesisMintUnits: parseDaoGenesisMintUnits(
          resolvedTokenomics.genesisMintWholeTokens
        ),
        initialHolder: effectiveHolder as `0x${string}`,
      });
    } catch (err) {
      // Never let a config/parse error become an uncaught onClick throw —
      // surface it in the wizard instead (client logs are console-only per the
      // observability spec; the visible error is the user-facing signal).
      setPatchError(
        err instanceof Error ? err.message : "Could not start DAO formation"
      );
    }
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
          <CheckCircle2 className="text-success size-10" />
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
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
            className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
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
          className="text-foreground text-sm font-medium"
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
          className="text-foreground text-sm font-medium"
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

      <div className="space-y-3">
        <div className="space-y-2">
          <div className="text-foreground text-sm font-medium">
            Ownership Template
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {DAO_TOKENOMICS_TEMPLATES.map((template) => {
              const selected = template.id === tokenomicsTemplateId;
              return (
                <button
                  key={template.id}
                  type="button"
                  disabled={!template.enabledInWizard}
                  onClick={() => setTokenomicsTemplateId(template.id)}
                  className={[
                    "rounded-md border p-3 text-left transition",
                    selected
                      ? "border-primary bg-primary/10"
                      : "border-border bg-background hover:border-primary/60",
                    !template.enabledInWizard
                      ? "cursor-not-allowed opacity-60"
                      : "",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">
                      {template.shortLabel}
                    </span>
                    {!template.enabledInWizard && (
                      <span className="bg-muted text-muted-foreground rounded-sm px-1.5 py-0.5 text-xs uppercase">
                        Next
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {template.description}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="tokenSupply"
            className="text-foreground text-sm font-medium"
          >
            Policy Supply
          </label>
          <span className="text-muted-foreground font-mono text-sm tabular-nums">
            {TOKEN_SUPPLY_FORMATTER.format(tokenPolicySupply)}
          </span>
        </div>
        <input
          id="tokenSupply"
          type="range"
          min={DAO_TOKEN_SUPPLY_MIN_WHOLE}
          max={DAO_TOKEN_SUPPLY_MAX_WHOLE}
          step={1_000}
          value={tokenPolicySupply}
          onChange={(e) => setTokenPolicySupply(e.currentTarget.valueAsNumber)}
          className="accent-primary w-full"
        />
        {resolvedTokenomics && (
          <div className="bg-muted/20 grid gap-3 rounded-md border p-3 sm:flex">
            <PieChart
              data={tokenomicsChart.chartData}
              config={tokenomicsChart.chartConfig}
              innerRadius={36}
              innerLabel={`${resolvedTokenomics.ownerCount}`}
              className="hidden aspect-square h-32 w-32 shrink-0 sm:block"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-muted-foreground">Genesis mint</div>
                  <div className="font-mono font-semibold tabular-nums">
                    {TOKEN_SUPPLY_FORMATTER.format(
                      resolvedTokenomics.genesisMintWholeTokens
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">
                    Future, not minted
                  </div>
                  <div className="font-mono font-semibold tabular-nums">
                    {TOKEN_SUPPLY_FORMATTER.format(
                      resolvedTokenomics.futureSupplyNotMintedWholeTokens
                    )}
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                {tokenomicsChart.legendEntries.map((entry) => (
                  <div
                    key={entry.label}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: entry.color }}
                      />
                      <span className="text-muted-foreground truncate">
                        {entry.label}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {TOKEN_SUPPLY_FORMATTER.format(entry.value)}
                      {entry.mintedAtFormation ? " minted" : " planned"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {!isValidSupply && (
          <p className="text-destructive text-sm">
            Supply must be between{" "}
            {TOKEN_SUPPLY_FORMATTER.format(DAO_TOKEN_SUPPLY_MIN_WHOLE)} and{" "}
            {TOKEN_SUPPLY_FORMATTER.format(DAO_TOKEN_SUPPLY_MAX_WHOLE)} tokens
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="initialHolder"
          className="text-foreground text-sm font-medium"
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
          Receives the genesis mint for the selected template. Defaults to your
          connected wallet if left empty.
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

      <Button
        onClick={handleSubmit}
        disabled={!canSubmit || (!isIdle && !canRetry)}
        className="w-full"
      >
        {canRetry ? "Try again" : "Create DAO"}
      </Button>

      {!formation.isSupported && (
        <HintText icon={<Info size={16} />}>
          Connect to Base to create and validate a production-shaped DAO
        </HintText>
      )}

      {patchError ? (
        <p className="text-destructive text-sm">{patchError}</p>
      ) : null}
    </StepSection>
  );
}
