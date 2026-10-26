// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/RowAction`
 * Purpose: Render a row's `payAction` (ONE_ROW_MODEL): the inline fund-steward control, or a "Top up ↗" link for vendor checkouts and external billing.
 * Scope: Client component. The fund-steward control is the page's only write: POST /api/v1/payments/steward-withdrawal (AMOUNT_ONLY, destination pinned server-side), ported from the retired AiFundingPanel.
 * Invariants: Rows without a payAction render nothing; semantic color tokens only; no destination address is accepted from the client.
 * Side-effects: IO (fetch POST → on-chain transfer) on user click.
 * Links: src/app/api/v1/payments/steward-withdrawal/route.ts, https://cognidao.org/knowledge/fund-cogni-vendors
 * @internal
 */
"use client";

import type { PayAction } from "@cogni/money-plane";
import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { Button, Input, ReportText } from "@/components";

type Phase = "idle" | "submitting" | "success" | "error";

function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function FundSteward() {
  const id = useId();
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
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Fund steward (USD)
        </label>
        <Input
          id={id}
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          aria-label="Fund steward (USD)"
          className="h-9 w-20 text-sm"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={phase === "submitting"}
        />
        <Button
          size="sm"
          className="h-9 whitespace-nowrap"
          onClick={submit}
          disabled={phase === "submitting" || !amountValid}
        >
          {phase === "submitting" ? (
            <>
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              Funding…
            </>
          ) : (
            "Fund steward"
          )}
        </Button>
      </div>
      {phase === "success" && txHash ? (
        <a
          href={`https://basescan.org/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-success text-xs hover:underline"
        >
          Sent {shortHash(txHash)}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ) : null}
      {phase === "error" && error ? (
        <ReportText variant="caption" tone="destructive" role="alert">
          {error}
        </ReportText>
      ) : null}
    </div>
  );
}

export function TopUpLink({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm" className="h-9">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLink aria-hidden="true" className="size-3" />
      </a>
    </Button>
  );
}

export function RowAction({
  action,
}: {
  action: PayAction | undefined;
}): React.ReactElement | null {
  if (!action) return null;
  if (action.kind === "fund-steward") return <FundSteward />;
  if (action.kind === "steward-checkout")
    return <TopUpLink href={action.checkoutUrl} label="Top up" />;
  return <TopUpLink href={action.url} label={action.label || "Top up"} />;
}
