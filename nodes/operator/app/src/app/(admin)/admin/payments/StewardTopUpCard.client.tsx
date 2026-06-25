// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/StewardTopUpCard.client`
 * Purpose: Admin control to fund the steward wallet from the operator wallet — the human
 *   "TRIGGER" of the manual provider top-up flow. Enter a USD amount, click, and a single
 *   USDC transfer (operator wallet → pinned steward wallet on Base) is signed via Privy.
 * Scope: Client component. POSTs to /api/v1/payments/steward-withdrawal (steward-self-authorized);
 *   renders the returned txHash (BaseScan link) or the structured error. Does NOT complete the
 *   vendor checkout (the human does that next from the steward wallet).
 * Invariants: AMOUNT_ONLY — the destination is repo-spec-pinned server-side; the form only sends amountUsd.
 * Side-effects: IO (fetch POST → on-chain transfer).
 * Links: src/app/api/v1/payments/steward-withdrawal/route.ts, docs/design/node-steward-wallet.md
 * @public
 */

"use client";

import { ExternalLink, Loader2, Wallet } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import { Button, HintText, Input, SectionCard } from "@/components";

type Phase = "idle" | "submitting" | "success" | "error";

interface Props {
  stewardAddress: string | null;
  operatorWalletAddress: string | null;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function StewardTopUpCard({
  stewardAddress,
  operatorWalletAddress,
}: Props): ReactElement {
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
  const disabled = phase === "submitting" || !amountValid || !stewardAddress;

  return (
    <SectionCard title="Fund Steward Wallet">
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Move USDC from the operator wallet to the human-custodied steward
          wallet on Base. Then settle vendor invoices (OpenRouter, Cherry) from
          that wallet via each vendor's USDC checkout.
        </p>
        <div className="grid gap-1 text-muted-foreground text-xs">
          <div className="flex items-center gap-2">
            <Wallet className="h-3.5 w-3.5" />
            <span>
              Operator wallet:{" "}
              <span className="font-mono">
                {operatorWalletAddress
                  ? shortAddr(operatorWalletAddress)
                  : "not configured"}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Wallet className="h-3.5 w-3.5" />
            <span>
              Steward wallet:{" "}
              <span className="font-mono">
                {stewardAddress ? shortAddr(stewardAddress) : "not configured"}
              </span>
            </span>
          </div>
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1">
            <label htmlFor="steward-amount-usd" className="font-medium text-sm">
              Amount (USD)
            </label>
            <Input
              id="steward-amount-usd"
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

        {!stewardAddress ? (
          <HintText>
            payments_out.steward_wallet is not configured in repo-spec.
          </HintText>
        ) : null}

        {phase === "success" && txHash ? (
          <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm">
            <p className="font-medium text-success">Transfer broadcast.</p>
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-muted-foreground text-xs hover:text-primary"
            >
              {shortAddr(txHash)}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ) : null}

        {phase === "error" && error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive text-sm">
            {error}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
