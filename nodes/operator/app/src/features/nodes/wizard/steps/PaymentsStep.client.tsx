// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/PaymentsStep.client`
 * Purpose: Final wizard step — open the payment-activation PR into the node's OWN repo. With a Split
 *   already deployed (`splitAddress` on the row), one click writes `node_wallet.address` +
 *   `payments_in.credits_topup.*` (95/5 at-cost) + `payments.status: active` into the node's
 *   `.cogni/repo-spec.yaml`. Provenance (repo-spec, Aragon DAO, node wallet) is shown with direct
 *   links — the user verifies, never vouches generated addresses.
 * Scope: POSTs `activate-payments`; presentational provenance + result links. No wallet interaction.
 * Side-effects: IO (POST /api/v1/nodes/:id/activate-payments), React state, router.refresh
 * Links: src/app/api/v1/nodes/[id]/activate-payments/route.ts, ../types.ts
 * @public
 */

"use client";

import { ExternalLink, Info, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Button, HintText } from "@/components";

import { StepSection } from "../StepSection";
import type { WizardStepProps } from "../types";

interface ActivationResult {
  readonly status: "pr_opened" | "no_changes";
  readonly prUrl?: string;
}

export function PaymentsStep({ node }: WizardStepProps): ReactElement {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActivationResult | null>(null);

  const provenance: ReadonlyArray<{ label: string; href: string }> = [
    ...(node.repoSpecUrl
      ? [{ label: "Node repo-spec", href: node.repoSpecUrl }]
      : []),
    ...(node.daoUrl ? [{ label: "Aragon DAO", href: node.daoUrl }] : []),
    ...(node.splitAddress
      ? [
          {
            label: "Split contract",
            href: `https://basescan.org/address/${node.splitAddress}`,
          },
        ]
      : []),
  ];

  const handleActivate = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/nodes/${node.id}/activate-payments`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason =
          typeof body.reason === "string"
            ? body.reason
            : typeof body.error === "string"
              ? body.error
              : `HTTP ${res.status}`;
        setError(reason);
        setSubmitting(false);
        return;
      }
      const activation = body.activation as ActivationResult | undefined;
      setResult(activation ?? { status: "no_changes" });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <StepSection title="Activate payments">
      <div className="space-y-5 text-sm">
        <p className="text-muted-foreground">
          This writes your node's wallet and revenue Split into its own{" "}
          <code>.cogni/repo-spec.yaml</code> and turns payments on. Incoming
          USDC routes to your node's Split, then funds its OpenRouter credits —
          the operator never holds your keys.
        </p>

        {/* What the node wallet is — plain explanation, no "confirm these are correct". */}
        <div className="flex items-start gap-3 rounded-md border bg-muted/50 p-4">
          <Wallet className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">Your node wallet</p>
            <p className="text-muted-foreground">
              A wallet your node controls. It receives the provider share of
              each payment and tops up your node's AI credits.
            </p>
            {node.operatorWalletAddress ? (
              <code className="break-all text-muted-foreground text-xs">
                {node.operatorWalletAddress}
              </code>
            ) : null}
          </div>
        </div>

        {/* Provenance links — verify, don't vouch. */}
        {provenance.length > 0 ? (
          <div className="space-y-2">
            <p className="font-medium text-foreground">
              Verify what gets written
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              {provenance.map((p) => (
                <Button
                  key={p.label}
                  asChild
                  variant="outline"
                  className="w-full"
                >
                  <a href={p.href} target="_blank" rel="noopener noreferrer">
                    {p.label}
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="space-y-3 rounded-md border bg-muted/50 p-4">
            <p className="font-medium text-foreground">
              {result.status === "pr_opened"
                ? "Activation PR opened on your node repo."
                : "Already activated — no changes needed."}
            </p>
            {result.prUrl ? (
              <Button asChild>
                <a
                  href={result.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View activation PR
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            ) : null}
            <HintText icon={<Info size={16} />}>
              Merge + deploy the PR (your AI dev handles this) to bring the rail
              live.
            </HintText>
          </div>
        ) : (
          <Button onClick={handleActivate} disabled={submitting} size="lg">
            {submitting ? "Activating…" : "Activate payments"}
          </Button>
        )}

        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </div>
    </StepSection>
  );
}
