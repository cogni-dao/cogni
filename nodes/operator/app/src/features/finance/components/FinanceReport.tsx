// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceReport`
 * Purpose: Compact, sortable Financials report using the existing app grid.
 * Scope: Presentation and shared read-only summaries; evidence expands on demand.
 * Invariants: Native units and wallet custody stay distinct; no payment controls.
 * Side-effects: Refreshes the current server page on request.
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
"use client";

import { type MoneyPlaneRow, summarizeCostRates } from "@cogni/money-plane";
import {
  type ColumnDef,
  type ExpandedState,
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useMemo, useState, useTransition } from "react";

import {
  Button,
  DataGrid,
  DataGridColumnHeader,
  DataGridContainer,
  DataGridTable,
} from "@/components";

import type { FinanceReportModel } from "../types";

import {
  amountLabel,
  compareAmounts,
  nativeBurn,
  observedLabel,
  rowAmount,
  type SortAmount,
} from "./format";

const statuses = {
  RED: { label: "Low", rank: 0, tone: "text-destructive" },
  YELLOW: { label: "Watch", rank: 1, tone: "text-warning" },
  UNKNOWN: { label: "Missing", rank: 2, tone: "text-muted-foreground" },
  GREEN: { label: "OK", rank: 3, tone: "text-success" },
  INFO: { label: "Holding", rank: 4, tone: "text-muted-foreground" },
} as const;

function Details({ row }: { row: MoneyPlaneRow }): ReactElement {
  return (
    <dl className="grid gap-x-8 gap-y-2 bg-muted/20 p-4 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">Source</dt>
        <dd>
          {row.source ?? "Unavailable"} · {row.freshness ?? "unknown"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Source observed</dt>
        <dd>{observedLabel(row.sourceObservedAt)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Read at</dt>
        <dd>{observedLabel(row.observedAt)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Payer</dt>
        <dd>{row.payer ?? "Unknown"}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Beneficiary / custody</dt>
        <dd className="break-words">{row.beneficiary ?? "Unknown"}</dd>
      </div>
      {row.balance !== null && Number.isFinite(row.balance) && row.currency && (
        <div>
          <dt className="text-muted-foreground">Supplied balance</dt>
          <dd>
            {String(row.balance)} {row.currency}
          </dd>
        </div>
      )}
      {!row.nativeRate &&
        row.burnPerDay !== null &&
        Number.isFinite(row.burnPerDay) &&
        row.currency && (
          <div>
            <dt className="text-muted-foreground">Supplied daily burn</dt>
            <dd>
              {String(row.burnPerDay)} {row.currency} / day
            </dd>
          </div>
        )}
      {row.nativeRate && (
        <div>
          <dt className="text-muted-foreground">Exact native rate</dt>
          <dd>
            {row.nativeRate.amount} {row.nativeRate.currency} /{" "}
            {row.nativeRate.per}
            {row.nativeRate.currency === "uact" && (
              <span className="ml-2 text-muted-foreground">
                ({Number(row.nativeRate.amount) / 1e6} ACT /{" "}
                {row.nativeRate.per})
              </span>
            )}
          </dd>
        </div>
      )}
      {row.cumulativeVendorTransfer && (
        <div>
          <dt className="text-muted-foreground">
            Provider transfers · cumulative
          </dt>
          <dd>
            {row.cumulativeVendorTransfer.amount}{" "}
            {row.cumulativeVendorTransfer.currency}
            {row.cumulativeVendorTransfer.currency === "uact" && (
              <span className="ml-2 text-muted-foreground">
                ({Number(row.cumulativeVendorTransfer.amount) / 1e6} ACT)
              </span>
            )}
          </dd>
        </div>
      )}
      {row.detail && (
        <div className="sm:col-span-2">
          <dt className="sr-only">Evidence note</dt>
          <dd>{row.detail}</dd>
        </div>
      )}
      {row.reasonCode && (
        <div>
          <dt className="text-muted-foreground">Missing evidence</dt>
          <dd>{row.reasonCode.replaceAll("_", " ")}</dd>
        </div>
      )}
    </dl>
  );
}

function moneyColumn(
  id: string,
  title: string,
  accessor: (row: MoneyPlaneRow) => SortAmount | undefined
): ColumnDef<MoneyPlaneRow> {
  return {
    id,
    accessorFn: accessor,
    sortUndefined: "last",
    sortingFn: (a, b) =>
      compareAmounts(accessor(a.original), accessor(b.original)),
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title={title} />
    ),
    cell: ({ row }) => (
      <span className="whitespace-nowrap tabular-nums">
        {amountLabel(accessor(row.original))}
      </span>
    ),
    meta: { headerTitle: title },
  };
}

export function FinanceReport({
  report,
}: {
  report: FinanceReportModel;
}): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sorting, setSorting] = useState<SortingState>([
    { id: "status", desc: false },
  ]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const summary = useMemo(
    () => summarizeCostRates(report.costRateEvidence),
    [report.costRateEvidence]
  );
  const costs = useMemo(
    () => report.rows.filter((row) => row.kind !== "wallet"),
    [report.rows]
  );
  const treasury = report.rows.find(
    (row) => row.kind === "wallet" && row.plane === report.treasuryPlane
  );
  const custody = report.rows.filter(
    (row) => row.kind === "wallet" && row.plane !== report.treasuryPlane
  );
  const evidence = useMemo(
    () => new Map(report.costRateEvidence.map((item) => [item.sourceId, item])),
    [report.costRateEvidence]
  );
  const columns = useMemo<ColumnDef<MoneyPlaneRow>[]>(
    () => [
      {
        id: "service",
        accessorKey: "label",
        size: 240,
        minSize: 200,
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Service" />
        ),
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <span
              className="block truncate font-medium"
              title={row.original.label}
            >
              {row.original.label}
            </span>
            <span
              className="block truncate text-muted-foreground text-xs"
              title={row.original.beneficiary}
            >
              {row.original.beneficiary ?? "Scope unknown"}
            </span>
          </div>
        ),
        meta: {
          headerTitle: "Service",
          expandedContent: (row) => <Details row={row} />,
        },
      },
      moneyColumn("balance", "Balance / credit", (row) => {
        const amount = rowAmount(row.balance, row.currency);
        return amount
          ? {
              ...amount,
              instrument: evidence.get(row.plane)?.instrumentId ?? row.plane,
            }
          : undefined;
      }),
      {
        ...moneyColumn("rate", "Rate", (row) => {
          const rate = nativeBurn(row);
          return rate
            ? {
                ...rate,
                instrument: evidence.get(row.plane)?.instrumentId ?? row.plane,
              }
            : undefined;
        }),
        size: 210,
        cell: ({ row }) => (
          <div className="whitespace-nowrap tabular-nums">
            {amountLabel(nativeBurn(row.original))}
            {nativeBurn(row.original) && (
              <span className="block text-muted-foreground text-xs">
                {evidence.get(row.original.plane)?.basis.kind === "contract"
                  ? "Contract rate"
                  : evidence.get(row.original.plane)?.basis.kind === "measured"
                    ? "Measured burn"
                    : "Basis unavailable"}
              </span>
            )}
          </div>
        ),
      },
      {
        id: "runway",
        size: 100,
        accessorFn: (row) =>
          row.runwayDays !== null && Number.isFinite(row.runwayDays)
            ? row.runwayDays
            : undefined,
        sortUndefined: "last",
        sortingFn: "basic",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Runway" />
        ),
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap tabular-nums">
            {getValue<number | undefined>() === undefined
              ? "—"
              : `${getValue<number>().toFixed(1)}d`}
          </span>
        ),
        meta: { headerTitle: "Runway" },
      },
      {
        id: "payer",
        accessorKey: "payer",
        size: 145,
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Funded by" />
        ),
        cell: ({ row }) => (
          <div className="text-sm">
            {row.original.payer ?? "Unknown"}
            {row.original.coverage === "operator-covered" && (
              <span className="block text-muted-foreground text-xs">
                Sponsored
              </span>
            )}
          </div>
        ),
        meta: { headerTitle: "Funded by" },
      },
      {
        id: "status",
        size: 110,
        accessorFn: (row) => statuses[row.grade].rank,
        sortingFn: (a, b) =>
          statuses[a.original.grade].rank - statuses[b.original.grade].rank ||
          (a.original.runwayDays ?? Number.MAX_VALUE) -
            (b.original.runwayDays ?? Number.MAX_VALUE),
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
          <span className={statuses[row.original.grade].tone}>
            {statuses[row.original.grade].label}
          </span>
        ),
        meta: { headerTitle: "Status" },
      },
      {
        id: "details",
        enableSorting: false,
        size: 48,
        header: () => <span className="sr-only">Details</span>,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={row.getIsExpanded()}
            aria-label={`${row.getIsExpanded() ? "Hide" : "Show"} ${row.original.label} details`}
            onClick={() => row.toggleExpanded()}
          >
            <ChevronDown
              aria-hidden="true"
              className={`size-4 ${row.getIsExpanded() ? "rotate-180" : ""}`}
            />
          </Button>
        ),
      },
    ],
    [evidence]
  );
  const table = useReactTable({
    data: costs,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
    getRowId: (row) => row.plane,
  });

  return (
    <div className="min-w-0 space-y-5">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-semibold text-2xl">Financials</h1>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
        >
          <RefreshCw
            aria-hidden="true"
            className={`size-4 ${pending ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </header>
      <dl>
        <dt className="text-muted-foreground text-xs">DAO treasury</dt>
        <dd className="font-semibold text-2xl tabular-nums">
          {amountLabel(
            treasury
              ? rowAmount(treasury.balance, treasury.currency)
              : undefined
          )}
        </dd>
        {treasury && (
          <dd>
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Treasury details
              </summary>
              <Details row={treasury} />
            </details>
          </dd>
        )}
      </dl>
      <section className="space-y-3" aria-label="Costs">
        <h2 className="font-medium">Costs</h2>
        <DataGrid
          table={table}
          recordCount={costs.length}
          tableLayout={{ dense: true, rowBorder: true, headerBackground: true }}
          emptyMessage="No reported costs."
        >
          <DataGridContainer className="max-w-full overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
        </DataGrid>
        {summary.cohorts.map((cohort, index) => (
          <div
            key={`${cohort.ownerId}:${cohort.scopeId}:${cohort.instrumentId}:${index}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-md bg-muted/30 px-3 py-2 text-sm"
          >
            <div>
              <span>
                {cohort.basis.kind === "contract"
                  ? cohort.instrumentId.startsWith("akash:")
                    ? "Known Akash contract rate"
                    : "Known contract rate"
                  : "Measured burn"}{" "}
                ·{" "}
                {cohort.scopeId === "operator-fleet"
                  ? "operator fleet"
                  : cohort.scopeId}
              </span>

              <span className="block text-muted-foreground text-xs">
                {cohort.ageUnknown
                  ? "Last known · age unknown"
                  : `Observed ${observedLabel(cohort.oldestObservedAt)}`}
                {cohort.basis.kind === "measured" &&
                  ` · ${observedLabel(cohort.basis.start)} – ${observedLabel(cohort.basis.end)}`}
              </span>
            </div>
            <span className="font-medium tabular-nums">
              {amountLabel(
                cohort.rate.amount === null
                  ? undefined
                  : { ...cohort.rate, amount: cohort.rate.amount }
              )}
              {cohort.partial && (
                <span className="ml-2 text-muted-foreground text-xs">
                  Partial
                </span>
              )}
            </span>
          </div>
        ))}
        {summary.unattributedCount > 0 && (
          <p className="text-muted-foreground text-xs">
            {summary.unattributedCount} cost sources lack attribution
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Partial cost coverage · Payment history unavailable
        </p>
      </section>
      <details className="rounded-md border">
        <summary className="cursor-pointer px-3 py-2 text-sm">
          Funding accounts
        </summary>
        <div className="divide-y px-3">
          {custody.map((row) => (
            <details key={row.plane} className="py-2">
              <summary className="flex cursor-pointer flex-wrap justify-between gap-2 text-sm">
                <span>
                  {row.label}
                  <span className="ml-2 text-muted-foreground text-xs">
                    {row.beneficiary}
                  </span>
                </span>
                <span className="tabular-nums">
                  {amountLabel(rowAmount(row.balance, row.currency))}
                </span>
              </summary>
              <Details row={row} />
            </details>
          ))}
        </div>
      </details>
    </div>
  );
}
