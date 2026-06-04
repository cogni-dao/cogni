// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/epoch/view`
 * Purpose: Unified epoch page — current epoch with countdown at top, past epochs (review + finalized) expandable below.
 * Scope: Renders all epoch data via useEpochsPage hook. Does not perform server-side logic.
 * Invariants: BigInt units displayed via Number() for presentation only. No credit math in UI.
 * Side-effects: IO (via useEpochsPage hook)
 * Links: docs/spec/epoch-ledger.md, src/features/governance/types.ts
 * @public
 */

"use client";

import { CheckCircle, Clock, Eye } from "lucide-react";
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
import { EpochCountdown } from "@/features/governance/components/EpochCountdown";
import { EpochDetail } from "@/features/governance/components/EpochDetail";
import { useEpochsPage } from "@/features/governance/hooks/useEpochsPage";
import { buildPieChartData } from "@/features/governance/lib/build-pie-data";
import type { EpochView } from "@/features/governance/types";

function StatusBadge({
  status,
}: {
  status: EpochView["status"];
}): ReactElement {
  switch (status) {
    case "finalized":
      return (
        <Badge
          intent="outline"
          size="sm"
          className="gap-1 border-success/40 text-success"
        >
          <CheckCircle className="h-3 w-3" />
          Finalized
        </Badge>
      );
    case "review":
      return (
        <Badge
          intent="outline"
          size="sm"
          className="gap-1 border-warning/40 text-warning"
        >
          <Eye className="h-3 w-3" />
          Review
        </Badge>
      );
    default:
      return (
        <Badge intent="default" size="sm" className="animate-pulse gap-1">
          <Clock className="h-3 w-3" />
          Active
        </Badge>
      );
  }
}

function CurrentEpochSection({
  epoch,
}: {
  readonly epoch: EpochView;
}): ReactElement {
  const sorted = useMemo(
    () =>
      [...epoch.contributors].sort((a, b) => Number(b.units) - Number(a.units)),
    [epoch.contributors]
  );

  const totalPoints = useMemo(
    () => sorted.reduce((s, c) => s + Math.round(Number(c.units) / 1000), 0),
    [sorted]
  );

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
    <div className="space-y-6">
      <div>
        <h1 className="mb-1 font-bold text-3xl tracking-tight">
          Epoch <span className="text-primary">#{epoch.id}</span>
        </h1>
        <p className="text-muted-foreground">
          {new Date(epoch.periodStart).toLocaleDateString()} —{" "}
          {new Date(epoch.periodEnd).toLocaleDateString()}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <EpochCountdown
          periodStart={epoch.periodStart}
          periodEnd={epoch.periodEnd}
          status={epoch.status}
          contributorCount={sorted.length}
          totalPoints={totalPoints}
        />
      </div>

      <EpochDetail epoch={epoch} hideHeader />
    </div>
  );
}

function PastEpochsSection({
  epochs,
}: {
  readonly epochs: readonly EpochView[];
}): ReactElement {
  if (epochs.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center">
        <p className="text-muted-foreground">No past epochs</p>
        <p className="mt-2 text-muted-foreground text-sm">
          Completed epochs will appear here after they are finalized.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead className="w-16">#</TableHead>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Contributors</TableHead>
            <TableHead className="text-right">Credits</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {epochs.map((epoch) => {
            const credits = epoch.poolTotalCredits
              ? Number(epoch.poolTotalCredits)
              : null;
            return (
              <ExpandableTableRow
                key={epoch.id}
                colSpan={7}
                cellClassNames={[
                  undefined,
                  undefined,
                  "text-right",
                  "text-right",
                  "text-right",
                ]}
                expandedContent={<EpochDetail epoch={epoch} />}
                cells={[
                  <span key="id" className="font-bold text-foreground/60">
                    {epoch.id}
                  </span>,
                  <span key="period" className="text-sm">
                    {new Date(epoch.periodStart).toLocaleDateString()} —{" "}
                    {new Date(epoch.periodEnd).toLocaleDateString()}
                  </span>,
                  <span key="contributors" className="text-right text-sm">
                    {epoch.contributors.length}
                  </span>,
                  <span key="credits" className="text-right font-mono text-xs">
                    {credits != null ? credits.toLocaleString() : "—"}
                  </span>,
                  <div key="status" className="flex justify-end">
                    <StatusBadge status={epoch.status} />
                  </div>,
                ]}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function CurrentEpochView(): ReactElement {
  const { data, isLoading, error } = useEpochsPage();

  if (error) {
    return (
      <div className="flex flex-col gap-8">
        <div className="rounded-lg border border-destructive bg-destructive/10 p-6">
          <h2 className="font-semibold text-destructive text-lg">
            Error loading epoch data
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
          <div className="h-28 rounded-lg bg-muted" />
          <div className="h-64 rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {data.current ? (
        <CurrentEpochSection epoch={data.current} />
      ) : (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-muted-foreground">No active epoch</p>
          <p className="mt-2 text-muted-foreground text-sm">
            A new epoch will appear here when one is opened.
          </p>
        </div>
      )}

      {data.pastEpochs.length > 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="font-semibold text-xl tracking-tight">
              Past Epochs
            </h2>
            <p className="text-muted-foreground text-sm">
              Previous epochs with signed credit distributions
            </p>
          </div>
          <PastEpochsSection epochs={data.pastEpochs} />
        </div>
      )}
    </div>
  );
}
