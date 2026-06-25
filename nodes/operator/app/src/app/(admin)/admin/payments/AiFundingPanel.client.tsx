// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/AiFundingPanel.client`
 * Purpose: The AI-funding pipeline view. Shows the three balances that decide AI runway and
 *   the two human actions that move money along the chain:
 *     user USDC → operator wallet (95%) → [Fund steward] → steward wallet → [Top up OpenRouter] → OpenRouter.
 *   `withdrawToSteward` is the load-bearing hop: the operator (Privy) wallet holds user-paid USDC
 *   but cannot complete OpenRouter's wallet-connect checkout, so a human pays from the steward wallet.
 * Scope: Client component. Reads balances from server props; the only write is the Fund-steward POST.
 *   The OpenRouter top-up itself is an external human checkout (we only link to it).
 * Invariants: AMOUNT_ONLY (destination pinned server-side); semantic color tokens only.
 * Side-effects: IO (fetch POST → on-chain transfer).
 * Links: src/app/api/v1/payments/steward-withdrawal/route.ts, funding.server.ts, docs/design/node-steward-wallet.md
 * @public
 */

"use client";

import {
  ArrowDown,
  ExternalLink,
  Loader2,
  Sparkles,
  Wallet,
} from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import { Button, Card, CardContent, HintText, Input } from "@/components";
import type { AiFunding } from "./funding.server";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/settings/credits";

type Phase = "idle" | "submitting" | "success" | "error";

function fmtUsd(n: number | null): string {
  return n === null ? "—" : `$${n.toFixed(2)}`;
}

function shortAddr(a: string | null): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "not configured";
}

function StageCard({
  icon: Icon,
  label,
  sub,
  amount,
  address,
  children,
}: {
  icon: typeof Wallet;
  label: string;
  sub: string;
  amount: string;
  address?: string | null;
  children?: ReactElement | null;
}): ReactElement {
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-0.5">
              <p className="font-semibold">{label}</p>
              <p className="text-muted-foreground text-xs">{sub}</p>
              {address !== undefined ? (
                <p className="font-mono text-muted-foreground/70 text-xs">
                  {shortAddr(address)}
                </p>
              ) : null}
            </div>
          </div>
          <p className="font-bold text-xl tabular-nums">{amount}</p>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Arrow({ label }: { label: string }): ReactElement {
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-muted-foreground text-xs">
      <ArrowDown className="h-3.5 w-3.5" />
      <span>{label}</span>
    </div>
  );
}

export function AiFundingPanel({
  funding,
}: {
  funding: AiFunding;
}): ReactElement {
  const [amount, setAmount] = useState("1");
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setPhase("submitting");
    setError(null);
    setTxHash(null);
    try {
      const res = await fetch("/api/v1/payments/steward-withdrawal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: Number(amount) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        txHash?: string;
        error?: string;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        setError(
          data.detail ?? data.error ?? data.code ?? `HTTP ${res.status}`
        );
        setPhase("error");
        return;
      }
      setTxHash(data.txHash ?? null);
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [amount]);

  const amountValid = Number(amount) > 0 && Number.isFinite(Number(amount));
  const disabled =
    phase === "submitting" || !amountValid || !funding.stewardWalletAddress;

  return (
    <div className="space-y-1">
      {/* Stage 1 — operator wallet (DAO working capital) */}
      <StageCard
        icon={Wallet}
        label="Operator wallet"
        sub="DAO working capital — 95% of user AI-credit payments land here."
        amount={`${fmtUsd(funding.operatorWalletUsdc)} USDC`}
        address={funding.operatorWalletAddress}
      >
        <div className="space-y-2 border-border border-t pt-3">
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1">
              <label htmlFor="fund-amount-usd" className="font-medium text-sm">
                Fund steward (USD)
              </label>
              <Input
                id="fund-amount-usd"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={phase === "submitting"}
              />
            </div>
            <Button onClick={submit} disabled={disabled}>
              {phase === "submitting" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Funding…
                </>
              ) : (
                "Fund steward"
              )}
            </Button>
          </div>
          {!funding.stewardWalletAddress ? (
            <HintText>
              payments_out.steward_wallet is not configured in repo-spec.
            </HintText>
          ) : null}
          {phase === "success" && txHash ? (
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-success text-xs hover:underline"
            >
              Transfer broadcast: {shortAddr(txHash)}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          {phase === "error" && error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive text-xs">
              {error}
            </div>
          ) : null}
        </div>
      </StageCard>

      <Arrow label="withdrawToSteward — moves DAO funds to a wallet a human can pay from" />

      {/* Stage 2 — steward wallet (human-custodied) */}
      <StageCard
        icon={Wallet}
        label="Steward wallet"
        sub="Human-custodied. Pay OpenRouter from here via its USDC checkout."
        amount={`${fmtUsd(funding.stewardWalletUsdc)} USDC`}
        address={funding.stewardWalletAddress}
      >
        <div className="border-border border-t pt-3">
          <Button asChild>
            <a
              href={OPENROUTER_CREDITS_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Top up OpenRouter
              <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          </Button>
          <HintText>
            Opens openrouter.ai/settings/credits — pay in USDC on Base from the
            steward wallet.
          </HintText>
        </div>
      </StageCard>

      <Arrow label="human completes OpenRouter's USDC checkout" />

      {/* Stage 3 — OpenRouter runway */}
      <StageCard
        icon={Sparkles}
        label="OpenRouter balance"
        sub="AI runway. When this hits zero, inference 402s."
        amount={fmtUsd(funding.openRouterRemainingUsd)}
      />
    </div>
  );
}
