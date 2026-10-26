// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceReport`
 * Purpose: Financials — one table (Line · Balance · Burn/day · Runway · Action) over the node's money planes, in risk order. The table is the page.
 * Scope: Presentation of one shared snapshot with the existing kit; stacked rows below 42rem (@2xl) container width so a 1024px viewport beside the admin sidebar still shows the table.
 * Invariants: ONE_ROW_MODEL — actions are row payActions. No pooled custody totals, no FX, no status pills, no horizontal scroll.
 *   Unknown is a muted dash; the reason lives in the row's dialog (the Line label opens it). A numeric column no row can fill is omitted.
 * Side-effects: Refreshes the server report on request.
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
"use client";

import {
  type ColumnDef,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import {
  Button,
  Card,
  CardContent,
  DataGrid,
  DataGridColumnHeader,
  DataGridContainer,
  DataGridTable,
  ReportText,
} from "@/components";
import type { FinanceReportModel, FinanceRow } from "../types";
import { FinanceSource } from "./FinanceSource";
import {
  balance,
  balanceLabel,
  burn,
  burnLabel,
  byRisk,
  fleetBurnLabel,
  refreshedLabel,
  runway,
  runwayLabel,
  runwayTone,
} from "./format";
import { RowAction } from "./RowAction";

const noop = () => () => {};
/** Server renders UTC; the browser re-renders in its own zone after hydration. */
function useViewerTimeZone(): string | undefined {
  return useSyncExternalStore(
    noop,
    () => undefined,
    () => "UTC"
  );
}

function Runway({ row }: { row: FinanceRow }) {
  const label = runwayLabel(row);
  return (
    <ReportText
      variant="amount"
      tone={label === "—" ? "muted" : runwayTone(row.grade)}
    >
      {label}
    </ReportText>
  );
}

function Amount({ children }: { children: string }) {
  return (
    <ReportText variant="amount" tone={children === "—" ? "muted" : "default"}>
      {children}
    </ReportText>
  );
}

const numeric = (
  id: string,
  title: string,
  value: (row: FinanceRow) => number | undefined,
  cell: (row: FinanceRow) => string
): ColumnDef<FinanceRow> => ({
  id,
  accessorFn: value,
  sortUndefined: "last",
  sortingFn: "basic",
  header: ({ column }) => (
    <DataGridColumnHeader column={column} title={title} />
  ),
  cell: ({ row }) => <Amount>{cell(row.original)}</Amount>,
  meta: { headerTitle: title, cellClassName: "whitespace-nowrap" },
});

export function FinanceReport({ report }: { report: FinanceReportModel }) {
  const router = useRouter();
  const timeZone = useViewerTimeZone();
  const [pending, startTransition] = useTransition();
  const [refreshMessage, setRefreshMessage] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const rows = useMemo(() => [...report.rows].sort(byRisk), [report.rows]);
  const hasBurn = rows.some((row) => row.burnPerDay !== null);
  const hasRunway = rows.some((row) => row.runwayDays !== null);
  const treasury = report.rows.find(
    (row) => row.plane === report.treasuryPlane
  );
  const summary = [
    treasury && balance(treasury) !== undefined
      ? `Treasury ${balanceLabel(treasury)}`
      : "",
    fleetBurnLabel(report.rows),
  ]
    .filter(Boolean)
    .join(" · ");
  const refreshed = refreshedLabel(report.takenAt, timeZone);

  const columns = useMemo<ColumnDef<FinanceRow>[]>(
    () => [
      {
        id: "line",
        accessorKey: "label",
        sortingFn: "alphanumeric",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Line" />
        ),
        cell: ({ row }) => (
          <FinanceSource row={row.original} timeZone={timeZone} />
        ),
        meta: { headerTitle: "Line" },
      },
      numeric("balance", "Balance", balance, balanceLabel),
      ...(hasBurn ? [numeric("burn", "Burn/day", burn, burnLabel)] : []),
      ...(hasRunway
        ? [
            {
              id: "runway",
              accessorFn: runway,
              sortUndefined: "last",
              sortingFn: "basic",
              header: ({ column }) => (
                <DataGridColumnHeader column={column} title="Runway" />
              ),
              cell: ({ row }) => <Runway row={row.original} />,
              meta: {
                headerTitle: "Runway",
                cellClassName: "whitespace-nowrap",
              },
            } satisfies ColumnDef<FinanceRow>,
          ]
        : []),
      {
        id: "action",
        enableSorting: false,
        header: "Action",
        cell: ({ row }) => <RowAction action={row.original.payAction} />,
        meta: { headerTitle: "Action", cellClassName: "text-right" },
      },
    ],
    [timeZone, hasBurn, hasRunway]
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.plane,
  });

  function refresh() {
    if (!navigator.onLine) {
      setRefreshMessage("You're offline. Reconnect to refresh this report.");
      return;
    }
    setRefreshMessage("");
    startTransition(() => {
      try {
        router.refresh();
        setRefreshMessage("Refresh requested.");
      } catch {
        setRefreshMessage("Refresh failed. Try again.");
      }
    });
  }

  return (
    <div className="@container w-full min-w-0 space-y-5" data-finance-report>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <ReportText as="h1" variant="title">
            Financials
          </ReportText>
          <ReportText variant="caption" tone="muted">
            Refreshed {refreshed}
          </ReportText>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={refresh}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {pending ? "Refreshing…" : "Refresh"}
        </Button>
        <output className="sr-only" aria-live="polite">
          {pending
            ? "Refreshing report."
            : refreshMessage
              ? `${refreshMessage} Refreshed ${refreshed}.`
              : ""}
        </output>
      </header>
      {summary && (
        <ReportText variant="label" data-finance-summary>
          {summary}
        </ReportText>
      )}
      <section
        className="@2xl:block hidden min-w-0"
        aria-label="Financials table"
      >
        <DataGrid
          table={table}
          recordCount={rows.length}
          tableLayout={{
            width: "auto",
            rowBorder: true,
            headerBackground: true,
          }}
          tableClassNames={{ base: "break-words" }}
          emptyMessage="No money planes configured."
        >
          <DataGridContainer>
            <DataGridTable />
          </DataGridContainer>
        </DataGrid>
      </section>
      <ul
        className="@2xl:hidden min-w-0 space-y-3"
        aria-label="Financials list"
      >
        {table.getRowModel().rows.map(({ original: row }) => (
          <li key={row.plane}>
            <Card className="py-0">
              <CardContent className="min-w-0 space-y-3 p-4">
                <FinanceSource row={row} timeZone={timeZone} />
                <dl className="grid min-w-0 grid-cols-3 gap-2">
                  <div>
                    <ReportText as="dt" variant="caption" tone="muted">
                      Balance
                    </ReportText>
                    <dd>
                      <Amount>{balanceLabel(row)}</Amount>
                    </dd>
                  </div>
                  {hasBurn && (
                    <div>
                      <ReportText as="dt" variant="caption" tone="muted">
                        Burn/day
                      </ReportText>
                      <dd>
                        <Amount>{burnLabel(row)}</Amount>
                      </dd>
                    </div>
                  )}
                  {hasRunway && (
                    <div>
                      <ReportText as="dt" variant="caption" tone="muted">
                        Runway
                      </ReportText>
                      <dd>
                        <Runway row={row} />
                      </dd>
                    </div>
                  )}
                </dl>
                {row.payAction && (
                  <div className="border-border border-t pt-3">
                    <RowAction action={row.payAction} />
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
