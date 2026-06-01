// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/EpochDetail`
 * Purpose: Reusable epoch detail view — pie chart of contributor shares + expandable contributions table.
 * Scope: Works for both open (current) and finalized (historical) epochs. Does not perform data fetching or server-side logic.
 * Invariants: BigInt units displayed via Number() for presentation only. No credit math in UI.
 * Side-effects: none
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import type { ReactElement } from "react";
import { useMemo } from "react";
import {
  Badge,
  ExpandableTableRow,
  PieChart,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { buildPieChartData } from "@/features/governance/lib/build-pie-data";
import type { EpochContributor, EpochView } from "@/features/governance/types";

import { ContributionRow } from "./ContributionRow";

export interface EpochDetailProps {
  readonly epoch: EpochView;
  /** Hide the header row (pie chart + epoch stats). Useful when shown inline under a parent. */
  readonly hideHeader?: boolean;
  /** Custom renderer for expanded contributor rows. Each element should be a TableRow. Overrides default ContributionRow list. */
  readonly renderExpandedRows?: (
    contributor: EpochContributor
  ) => ReactElement[] | null;
}

export function EpochDetail({
  epoch,
  hideHeader = false,
  renderExpandedRows,
}: EpochDetailProps): ReactElement {
  const sorted = useMemo(
    () =>
      [...epoch.contributors].sort((a, b) => Number(b.units) - Number(a.units)),
    [epoch.contributors]
  );

  const credits = epoch.poolTotalCredits
    ? Number(epoch.poolTotalCredits)
    : null;

  const { chartData, chartConfig, legendEntries } = useMemo(
    () =>
      buildPieChartData(
        sorted.map((c) => ({
          key: c.displayName ?? c.claimantLabel,
          value: c.creditShare,
        }))
      ),
    [sorted]
  );

  return (
    <div className="space-y-4">
      {!hideHeader && (
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
          <div className="hidden items-center gap-3 sm:flex">
            <PieChart
              data={chartData}
              config={chartConfig}
              innerRadius={45}
              innerLabel={`#${epoch.id}`}
              className="aspect-square h-44 shrink-0"
            />
            <div className="flex flex-col gap-1.5">
              {legendEntries.map((e) => (
                <div key={e.label} className="flex items-center gap-2 text-xs">
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: e.color }}
                  />
                  <span className="text-muted-foreground">{e.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold text-lg">Epoch #{epoch.id}</h3>
            <div className="text-muted-foreground text-sm">
              {new Date(epoch.periodStart).toLocaleDateString()} —{" "}
              {new Date(epoch.periodEnd).toLocaleDateString()}
            </div>
            <div className="flex gap-4 text-xs">
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {sorted.length}
                </span>{" "}
                contributors
              </span>
              {credits != null && (
                <span className="text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {credits.toLocaleString()}
                  </span>{" "}
                  credits
                </span>
              )}
              {epoch.unresolvedCount > 0 && (
                <span className="text-warning">
                  {epoch.unresolvedCount} unresolved
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="w-10 text-center">#</TableHead>
              <TableHead>Contributor</TableHead>
              <TableHead className="text-right">Share</TableHead>
              <TableHead className="text-right">Score</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((c, i) => {
              const totalScore = c.units;
              return (
                <ExpandableTableRow
                  key={c.claimantKey}
                  colSpan={6}
                  cellClassNames={[
                    "w-10 text-center",
                    undefined,
                    "text-right",
                    "text-right",
                  ]}
                  expandedRows={
                    renderExpandedRows
                      ? (renderExpandedRows(c) ?? [])
                      : c.receipts.map((r) => (
                          <ContributionRow key={r.receiptId} receipt={r} />
                        ))
                  }
                  cells={[
                    <span key="rank" className="text-muted-foreground text-xs">
                      {i + 1}
                    </span>,
                    <div key="name" className="flex items-center gap-2">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm">
                        {c.avatar}
                      </div>
                      <span className="font-medium text-sm">
                        {c.displayName ?? "Contributor"}
                      </span>
                      {!c.isLinked && (
                        <Badge
                          intent="outline"
                          size="sm"
                          className="h-5 px-1.5"
                        >
                          Unlinked
                        </Badge>
                      )}
                    </div>,
                    <span key="share" className="font-medium text-sm">
                      {c.creditShare}%
                    </span>,
                    <span key="score" className="font-mono text-xs">
                      {totalScore}
                    </span>,
                  ]}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
