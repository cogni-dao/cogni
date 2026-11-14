// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/holdings/view`
 * Purpose: Client component for the Ownership page — separates current issued token supply,
 *   the viewer's independent wallet/allocation facts, and finalized attribution credits.
 * Scope: Renders on-chain reads (via the child panels' useNodeTokenomics/useCumulativeClaim) and
 *   attribution data (via useHoldings). The child panels source the node's token/distributor/chain from
 *   repo-spec (public tokenomics route), NOT a claim manifest — so tokenomics render with zero epochs.
 *   Does not perform server-side logic or direct DB access.
 * Invariants:
 *   - ALL_MATH_BIGINT: token amounts stay bigint; formatted only at display.
 *   - TOKENS_ARE_NOT_CREDITS: finalized credits are never presented as current token ownership.
 *   - BALANCE_IS_NOT_PROVENANCE: current wallet balance is not decomposed by inferred origin.
 *   - CLAIM_UNCHANGED: the Claim affordance is CumulativeClaimPanel (embedded bare via YourPositionPanel) — chrome only; no claim-math changes.
 * Side-effects: IO (useHoldings), blockchain read (via child panels)
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import { Coins, TrendingUp, Users } from "lucide-react";
import type { ReactElement } from "react";

import {
  Card,
  CardContent,
  Progress,
  Table,
  TableBody,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { HoldingRow } from "@/features/governance/components/HoldingCard";
import { NodeTokenomicsPanel } from "@/features/governance/components/NodeTokenomicsPanel";
import { YourPositionPanel } from "@/features/governance/components/YourPositionPanel";
import { useHoldings } from "@/features/governance/hooks/useHoldings";
import type { AttributionCreditBar } from "@/features/governance/lib/tokenomics-visuals";
import {
  buildAttributionCreditBars,
  formatCreditAmount,
} from "@/features/governance/lib/tokenomics-visuals";

export function HoldingsView(): ReactElement {
  const { data, isLoading, error } = useHoldings();

  if (error) {
    return (
      <div className="flex flex-col gap-8">
        <div className="rounded-lg border border-destructive bg-destructive/10 p-6">
          <h2 className="font-semibold text-destructive text-lg">
            Error loading holdings data
          </h2>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-8">
        <div className="animate-pulse space-y-8">
          <div className="h-8 w-48 rounded-md bg-muted" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="h-20 rounded-lg bg-muted" />
            <div className="h-20 rounded-lg bg-muted" />
            <div className="h-20 rounded-lg bg-muted" />
          </div>
          <div className="h-64 rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  const creditBars = buildAttributionCreditBars(data.holdings);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-1 font-bold text-3xl tracking-tight">Ownership</h1>
        <p className="text-muted-foreground">
          This node&apos;s tokenomics and your token position
        </p>
      </div>

      <NodeTokenomicsPanel finalizedCredits={data.totalCreditsIssued} />

      <YourPositionPanel />

      <div>
        <h2 className="mb-3 font-semibold text-lg">Attribution credits</h2>
        <p className="mb-3 text-muted-foreground text-sm">
          How finalized off-chain credits were allocated. This is not current
          token ownership or a wallet-balance chart.
        </p>

        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Card className="border-border/50 bg-card/50">
            <CardContent className="flex items-center gap-4 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                <Coins className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="font-bold text-2xl">
                  {formatCreditAmount(data.totalCreditsIssued)}
                </div>
                <div className="text-muted-foreground text-xs">
                  Finalized attribution credits
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-card/50">
            <CardContent className="flex items-center gap-4 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15">
                <Users className="h-5 w-5 text-accent" />
              </div>
              <div>
                <div className="font-bold text-2xl">
                  {data.totalContributors}
                </div>
                <div className="text-muted-foreground text-xs">
                  Total Contributors
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-card/50">
            <CardContent className="flex items-center gap-4 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/15">
                <TrendingUp className="h-5 w-5 text-success" />
              </div>
              <div>
                <div className="font-bold text-2xl">{data.epochsCompleted}</div>
                <div className="text-muted-foreground text-xs">
                  Epochs Completed
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {data.holdings.length === 0 ? (
          // HONEST_EMPTY (story.5003): name the proven cause, never a bare "no data".
          <div className="rounded-lg border bg-card p-12 text-center">
            <p className="text-muted-foreground">
              {data.epochsCompleted === 0
                ? "No attribution epochs have been finalized yet — contributor credit allocations appear after the first epoch completes."
                : "No contributor credit allocations are recorded in finalized epochs yet."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <AttributionCreditBars bars={creditBars} />
            <div className="overflow-x-auto rounded-lg border lg:col-span-2">
              <Table>
                <TableCaption>
                  Exact finalized credit totals for every contributor
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 text-center">#</TableHead>
                    <TableHead>Contributor</TableHead>
                    <TableHead className="text-right">Credits</TableHead>
                    <TableHead className="text-right">
                      Share of credits
                    </TableHead>
                    <TableHead className="text-right">Epochs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.holdings.map((h, i) => (
                    <HoldingRow key={h.claimantKey} holding={h} rank={i + 1} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AttributionCreditBars({
  bars,
}: {
  bars: readonly AttributionCreditBar[];
}): ReactElement {
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <p className="font-semibold text-sm">Finalized credit share</p>
        <p className="text-muted-foreground text-xs">
          {bars.some((bar) => bar.isOther)
            ? "Top five contributors; everyone else is grouped as Other"
            : "Ranked by exact finalized credit totals"}
        </p>
      </div>
      <ol className="space-y-4">
        {bars.map((bar, index) => (
          <li key={bar.key} className="space-y-1.5">
            <div className="flex items-start justify-between gap-3 text-sm">
              <span className="min-w-0 font-medium">
                <span className="mr-2 text-muted-foreground">{index + 1}.</span>
                {bar.label}
              </span>
              <span className="shrink-0 text-right font-mono tabular-nums">
                {formatCreditAmount(bar.totalCredits)} ·{" "}
                {bar.sharePercent.toLocaleString()}%
              </span>
            </div>
            <Progress
              value={bar.sharePercent}
              aria-label={`${bar.label}: ${formatCreditAmount(bar.totalCredits)} finalized credits, ${bar.sharePercent.toLocaleString()} percent of finalized credits`}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}
