// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceReport`
 * Purpose: Compact, sortable Payments report using the existing app grid.
 * Scope: Presentation and shared read-only summaries; evidence expands on demand.
 * Invariants: Native units and wallet custody stay distinct; no payment controls.
 * Side-effects: Refreshes the current server page on request.
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
"use client";

import {
  type MoneyPlaneRow,
  type MoneyPlaneSnapshot,
  summarizeRows,
} from "@cogni/money-plane";
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
        <dt className="text-muted-foreground">Observed</dt>
        <dd>{observedLabel(row.sourceObservedAt)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Payer</dt>
        <dd>{row.payer ?? "Unknown"}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Beneficiary / custody</dt>
        <dd className="break-words">{row.beneficiary ?? "Unknown"}</dd>
      </div>
      {row.nativeRate && (
        <div>
          <dt className="text-muted-foreground">Exact native rate</dt>
          <dd>
            {row.nativeRate.amount} {row.nativeRate.currency} /{" "}
            {row.nativeRate.per}
          </dd>
        </div>
      )}
      {row.cumulativeVendorTransfer && (
        <div>
          <dt className="text-muted-foreground">
            Paid · cumulative provider transfer
          </dt>
          <dd>
            {row.cumulativeVendorTransfer.amount}{" "}
            {row.cumulativeVendorTransfer.currency}
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

function Amounts({
  values,
  partial = false,
}: {
  values: readonly SortAmount[];
  partial?: boolean;
}): ReactElement {
  return (
    <span className="tabular-nums">
      {values.length ? values.map(amountLabel).join(" · ") : "—"}
      {partial && (
        <span
          className="ml-1 text-muted-foreground"
          title="Known subtotal; some evidence is missing or stale"
        >
          *
        </span>
      )}
    </span>
  );
}

export function FinanceReport({
  report,
}: {
  report: MoneyPlaneSnapshot;
}): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sorting, setSorting] = useState<SortingState>([
    { id: "status", desc: false },
  ]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const summary = useMemo(() => summarizeRows(report.rows), [report.rows]);
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
            {row.original.kind !== "wallet" &&
              row.original.coverage === "operator-covered" && (
                <span className="block text-muted-foreground text-xs">
                  Sponsored
                </span>
              )}
          </div>
        ),
        meta: {
          headerTitle: "Service",
          expandedContent: (row) => <Details row={row} />,
        },
      },
      moneyColumn("balance", "Balance", (row) =>
        rowAmount(row.balance, row.currency)
      ),
      moneyColumn("burn", "Burn", nativeBurn),
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
      moneyColumn(
        "paid",
        "Paid (cumulative)",
        (row) => row.cumulativeVendorTransfer
      ),
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
    []
  );
  const table = useReactTable({
    data: report.rows,
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
  const partial =
    summary.wallets.partial ||
    summary.prepaid.partial ||
    summary.burn.partial ||
    summary.paid.partial;

  return (
    <div className="min-w-0 space-y-5">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-semibold text-2xl">Payments</h1>
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
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        <div>
          <dt className="text-muted-foreground text-xs">
            Wallets · all custody
          </dt>
          <dd className="font-semibold text-xl">
            <Amounts
              values={summary.wallets.amounts}
              partial={summary.wallets.partial}
            />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Prepaid</dt>
          <dd className="font-semibold text-xl">
            <Amounts
              values={summary.prepaid.amounts}
              partial={summary.prepaid.partial}
            />
          </dd>
        </div>
      </dl>
      <DataGrid
        table={table}
        recordCount={report.rows.length}
        tableLayout={{ dense: true, rowBorder: true, headerBackground: true }}
        emptyMessage="No reported sources."
      >
        <DataGridContainer className="max-w-full overflow-x-auto">
          <DataGridTable
            footerContent={
              <tr>
                <td className="px-2 py-3 font-medium">Known totals</td>
                <td className="px-2 py-3">
                  <div>
                    Wallets{" "}
                    <Amounts
                      values={summary.wallets.amounts}
                      partial={summary.wallets.partial}
                    />
                  </div>
                  <div>
                    Prepaid{" "}
                    <Amounts
                      values={summary.prepaid.amounts}
                      partial={summary.prepaid.partial}
                    />
                  </div>
                </td>
                <td className="px-2 py-3">
                  <Amounts
                    values={summary.burn.rates}
                    partial={summary.burn.partial}
                  />
                </td>
                <td className="px-2 py-3">—</td>
                <td className="px-2 py-3">
                  <Amounts
                    values={summary.paid.amounts}
                    partial={summary.paid.partial}
                  />
                </td>
                <td />
                <td />
              </tr>
            }
          />
        </DataGridContainer>
      </DataGrid>
      {partial && (
        <p className="text-muted-foreground text-xs">* Partial evidence</p>
      )}
    </div>
  );
}
