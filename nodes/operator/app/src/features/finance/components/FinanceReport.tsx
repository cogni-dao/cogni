// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceReport`
 * Purpose: Responsive, readable DAO reporting using the existing kit and shared finance logic.
 * Scope: One sorted model drives cards and the adaptive Services grid.
 * Invariants: No pooled custody, empty numeric columns, horizontal scroller or payment actions.
 * Side-effects: Refreshes the existing server report on request.
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
"use client";

import { type MoneyPlaneRow, summarizeCostRates } from "@cogni/money-plane";
import {
  type ColumnDef,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  DataGrid,
  DataGridColumnHeader,
  DataGridContainer,
  DataGridTable,
  ReportText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import type { FinanceReportModel } from "../types";
import { FinanceSource } from "./FinanceSource";
import {
  amountLabel,
  compareAmounts,
  nativeBurn,
  observedLabel,
  rowAmount,
  type SortAmount,
} from "./format";

const ranks = { RED: 0, YELLOW: 1, UNKNOWN: 2, GREEN: 3, INFO: 4 };
function Status({ row }: { row: MoneyPlaneRow }) {
  const label = {
    RED: "Low runway",
    YELLOW: "Watch",
    UNKNOWN: nativeBurn(row) ? "Forecast unavailable" : "Not reported",
    GREEN: "OK",
    INFO: "Holding",
  }[row.grade];
  return (
    <Badge
      intent={row.grade === "RED" ? "destructive" : "secondary"}
      size="sm"
      className="px-2 py-1"
    >
      {label}
    </Badge>
  );
}
const keys = {
  status: "Status",
  balance: "Balance / credit",
  rate: "Rate",
  runway: "Runway",
} as const;
type SortKey = keyof typeof keys;
function runway(row: MoneyPlaneRow) {
  return row.runwayDays !== null &&
    Number.isFinite(row.runwayDays) &&
    row.runwayDays >= 0
    ? row.runwayDays
    : undefined;
}

const rateAge = (row: MoneyPlaneRow) =>
  row.sourceObservedAt
    ? row.freshness === "stale"
      ? "Stale source"
      : ""
    : "Age unknown";

export function FinanceReport({ report }: { report: FinanceReportModel }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refreshMessage, setRefreshMessage] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "status", desc: false },
  ]);
  const costs = useMemo(
    () => report.rows.filter((row) => row.kind !== "wallet"),
    [report.rows]
  );
  const evidence = useMemo(
    () => new Map(report.costRateEvidence.map((item) => [item.sourceId, item])),
    [report.costRateEvidence]
  );
  const summary = useMemo(
    () => summarizeCostRates(report.costRateEvidence),
    [report.costRateEvidence]
  );
  const treasury = report.rows.find(
    (row) => row.kind === "wallet" && row.plane === report.treasuryPlane
  );
  const identifiedTreasury =
    treasury && report.configuredWalletPlanes.includes(treasury.plane);
  const custody = report.rows.filter(
    (row) =>
      row.kind === "wallet" &&
      row.plane !== report.treasuryPlane &&
      report.configuredWalletPlanes.includes(row.plane)
  );
  const visible = {
    balance: costs.some((row) => rowAmount(row.balance, row.currency)),
    rate: costs.some((row) => nativeBurn(row)),
    runway: costs.some((row) => runway(row) !== undefined),
  };
  const sortKeys = (Object.keys(keys) as SortKey[]).filter(
    (key) => key === "status" || visible[key]
  );
  const currentSort = sorting[0];
  const activeSorting =
    currentSort && sortKeys.includes(currentSort.id as SortKey)
      ? sorting
      : [{ id: "status", desc: false }];
  const active = activeSorting[0] ?? { id: "status", desc: false };
  const sponsored = costs.some((row) => row.coverage === "operator-covered");
  const rateCaption = useCallback(
    (row: MoneyPlaneRow) =>
      evidence.get(row.plane)?.basis.kind === "contract"
        ? "Contract rate"
        : evidence.get(row.plane)?.basis.kind === "measured"
          ? "Measured burn"
          : "Reported rate",
    [evidence]
  );
  const service = useCallback(
    (row: MoneyPlaneRow) => (
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <ReportText variant="label">{row.label}</ReportText>
          {row.beneficiary && row.beneficiary !== "Fleet" && (
            <ReportText variant="caption" tone="muted">
              {row.beneficiary}
            </ReportText>
          )}
          {row.coverage !== "operator-covered" && (
            <ReportText variant="caption" tone="muted">
              Funded by{" "}
              {row.payer && row.payer !== "Not established"
                ? row.payer
                : "unknown payer"}
            </ReportText>
          )}
        </div>
        <FinanceSource row={row} evidence={evidence.get(row.plane)} />
      </div>
    ),
    [evidence]
  );
  const moneyColumn = useCallback(
    (
      id: "balance" | "rate",
      accessor: (row: MoneyPlaneRow) => SortAmount | undefined
    ): ColumnDef<MoneyPlaneRow> => ({
      id,
      accessorFn: (row) => {
        const value = accessor(row);
        return value
          ? {
              ...value,
              instrument: evidence.get(row.plane)?.instrumentId ?? row.plane,
            }
          : undefined;
      },
      sortUndefined: "last",
      sortingFn: (a, b) => compareAmounts(a.getValue(id), b.getValue(id)),
      header: ({ column }) => (
        <DataGridColumnHeader column={column} title={keys[id]} />
      ),
      cell: ({ row }) => (
        <div className="min-w-0 space-y-1">
          <ReportText variant="amount">
            {amountLabel(accessor(row.original))}
          </ReportText>
          {id === "rate" && accessor(row.original) && (
            <ReportText variant="caption" tone="muted">
              {rateCaption(row.original)}
              {rateAge(row.original) ? ` · ${rateAge(row.original)}` : ""}
            </ReportText>
          )}
        </div>
      ),
      meta: { headerTitle: keys[id] },
    }),
    [evidence, rateCaption]
  );
  const columns = useMemo<ColumnDef<MoneyPlaneRow>[]>(
    () => [
      {
        id: "service",
        accessorKey: "label",
        enableSorting: false,
        header: "Service",
        cell: ({ row }) => service(row.original),
      },
      ...(visible.balance
        ? [
            moneyColumn("balance", (row) =>
              rowAmount(row.balance, row.currency)
            ),
          ]
        : []),
      ...(visible.rate ? [moneyColumn("rate", nativeBurn)] : []),
      ...(visible.runway
        ? [
            {
              id: "runway",
              accessorFn: runway,
              sortUndefined: "last" as const,
              sortingFn: "basic" as const,
              header: ({ column }) => (
                <DataGridColumnHeader column={column} title="Runway" />
              ),
              cell: ({ getValue }) => (
                <ReportText variant="amount">
                  {getValue<number | undefined>() === undefined
                    ? "—"
                    : `${getValue<number>().toFixed(1)} days`}
                </ReportText>
              ),
              meta: { headerTitle: "Runway" },
            } satisfies ColumnDef<MoneyPlaneRow>,
          ]
        : []),
      {
        id: "status",
        accessorFn: (row) => ranks[row.grade],
        sortingFn: (a, b) =>
          ranks[a.original.grade] - ranks[b.original.grade] ||
          (runway(a.original) ?? Number.MAX_VALUE) -
            (runway(b.original) ?? Number.MAX_VALUE),
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => <Status row={row.original} />,
        meta: { headerTitle: "Status" },
      },
    ],
    [visible.balance, visible.rate, visible.runway, moneyColumn, service]
  );
  const table = useReactTable({
    data: costs,
    columns,
    state: { sorting: activeSorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.plane,
  });
  const missing = (Object.keys(visible) as (keyof typeof visible)[])
    .filter((key) => !visible[key])
    .map((key) => keys[key].toLowerCase());
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
    <div
      className="@container mx-auto w-full min-w-0 max-w-6xl space-y-6"
      data-finance-report
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <ReportText as="h1" variant="title">
            Financials
          </ReportText>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <ReportText variant="caption" tone="muted">
              DAO treasury and operator-funded services
            </ReportText>
            <ReportText variant="caption" tone="muted">
              Report refreshed {observedLabel(report.takenAt)}
            </ReportText>
          </div>
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
              ? `${refreshMessage} Report refreshed ${observedLabel(report.takenAt)}.`
              : ""}
        </output>
      </header>
      <div className="grid min-w-0 @3xl:grid-cols-2 gap-4">
        <Card className="py-0">
          <CardContent className="space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ReportText variant="label">DAO treasury</ReportText>
              {identifiedTreasury && <FinanceSource row={treasury} />}
            </div>
            <ReportText variant="value">
              {identifiedTreasury
                ? rowAmount(treasury.balance, treasury.currency)
                  ? amountLabel(rowAmount(treasury.balance, treasury.currency))
                  : "Balance unavailable"
                : "Treasury not identified"}
            </ReportText>
            {identifiedTreasury && (
              <ReportText variant="caption" tone="muted">
                {treasury.sourceObservedAt
                  ? `Balance observed ${observedLabel(treasury.sourceObservedAt)}${treasury.freshness === "stale" ? " · Stale" : ""}`
                  : "Source age unknown"}
              </ReportText>
            )}
          </CardContent>
        </Card>
        {summary.cohorts.length ? (
          <Card className="py-0">
            <CardContent className="space-y-4 p-4">
              {summary.cohorts.map((cohort, index) => (
                <div
                  key={`${cohort.instrumentId}:${index}`}
                  className="space-y-1"
                >
                  <ReportText variant="label">
                    {cohort.basis.kind === "contract"
                      ? "Known contract rate"
                      : "Measured burn"}{" "}
                    ·{" "}
                    {cohort.scopeId === "operator-fleet"
                      ? "operator fleet"
                      : cohort.scopeId}
                  </ReportText>
                  <ReportText variant="value">
                    {amountLabel(
                      cohort.rate.amount === null
                        ? undefined
                        : { ...cohort.rate, amount: cohort.rate.amount }
                    )}
                  </ReportText>
                  <ReportText variant="caption" tone="muted">
                    {[
                      ...new Set(
                        report.costRateEvidence
                          .filter(
                            (item) =>
                              item.instrumentId === cohort.instrumentId &&
                              item.ownerId === cohort.ownerId &&
                              item.scopeId === cohort.scopeId
                          )
                          .map(
                            (item) =>
                              report.rows.find(
                                (row) => row.plane === item.sourceId
                              )?.label
                          )
                          .filter(Boolean)
                      ),
                    ].join(" / ")}{" "}
                    ·{" "}
                    {cohort.ownerId === "operator"
                      ? "Funded by operator"
                      : `Funded by ${cohort.ownerId}`}{" "}
                    · {cohort.partial ? "Partial coverage · " : ""}
                    {cohort.ageUnknown
                      ? "Last known · age unknown"
                      : `Observed ${observedLabel(cohort.oldestObservedAt)}`}
                  </ReportText>
                  {cohort.basis.kind === "measured" && (
                    <ReportText variant="caption" tone="muted">
                      {observedLabel(cohort.basis.start)} –{" "}
                      {observedLabel(cohort.basis.end)}
                    </ReportText>
                  )}
                </div>
              ))}
              {summary.unattributedCount > 0 && (
                <ReportText variant="caption" tone="muted">
                  {summary.unattributedCount} cost sources lack attribution.
                </ReportText>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="py-0">
            <CardContent className="space-y-2 p-4">
              <ReportText variant="label">Operator-funded</ReportText>
              <ReportText tone="muted">
                Service costs are not yet reported.
              </ReportText>
            </CardContent>
          </Card>
        )}
      </div>
      <section className="min-w-0 space-y-3" aria-label="Services">
        <div>
          <ReportText as="h2" variant="section">
            Services
          </ReportText>
          {sponsored && (
            <ReportText variant="caption" tone="muted">
              Funded by operator
            </ReportText>
          )}
        </div>
        {missing.length > 0 && (
          <ReportText variant="caption" tone="muted">
            Not yet available: {missing.join(", ")}.
          </ReportText>
        )}
        <section
          className="@3xl:block hidden min-w-0"
          aria-label="Services table"
        >
          <DataGrid
            table={table}
            recordCount={costs.length}
            tableLayout={{
              width: "auto",
              rowBorder: true,
              headerBackground: true,
            }}
            tableClassNames={{ base: "break-words" }}
            emptyMessage="No services reported."
          >
            <DataGridContainer>
              <DataGridTable />
            </DataGridContainer>
          </DataGrid>
        </section>
        <section
          className="@3xl:hidden min-w-0 space-y-3"
          aria-label="Services list"
        >
          <div className="grid grid-cols-2 gap-2">
            <Select
              value={active.id}
              onValueChange={(id) => setSorting([{ id, desc: active.desc }])}
            >
              <SelectTrigger
                aria-label="Sort services by"
                className="min-h-11 w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sortKeys.map((key) => (
                  <SelectItem key={key} value={key}>
                    {keys[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={active.desc ? "descending" : "ascending"}
              onValueChange={(direction) =>
                setSorting([
                  { id: active.id, desc: direction === "descending" },
                ])
              }
            >
              <SelectTrigger
                aria-label="Sort direction"
                className="min-h-11 w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ascending">Ascending</SelectItem>
                <SelectItem value="descending">Descending</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {table.getRowModel().rows.map(({ original: row }) => (
            <Card key={row.plane} className="py-0">
              <CardContent className="min-w-0 space-y-3 p-4">
                <div className="min-w-0 space-y-1">
                  <ReportText variant="label">{row.label}</ReportText>
                  {row.beneficiary && row.beneficiary !== "Fleet" && (
                    <ReportText variant="caption" tone="muted">
                      {row.beneficiary}
                    </ReportText>
                  )}
                  {row.coverage !== "operator-covered" && (
                    <ReportText variant="caption" tone="muted">
                      Funded by{" "}
                      {row.payer && row.payer !== "Not established"
                        ? row.payer
                        : "unknown payer"}
                    </ReportText>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Status row={row} />
                  <FinanceSource row={row} evidence={evidence.get(row.plane)} />
                </div>
                <dl className="grid min-w-0 gap-3">
                  {rowAmount(row.balance, row.currency) && (
                    <div>
                      <ReportText as="dt" variant="caption" tone="muted">
                        Balance / credit
                      </ReportText>
                      <ReportText as="dd" variant="amount">
                        {amountLabel(rowAmount(row.balance, row.currency))}
                      </ReportText>
                    </div>
                  )}
                  {nativeBurn(row) && (
                    <div>
                      <ReportText as="dt" variant="caption" tone="muted">
                        {rateCaption(row)}
                        {rateAge(row) ? ` · ${rateAge(row)}` : ""}
                      </ReportText>
                      <ReportText as="dd" variant="amount">
                        {amountLabel(nativeBurn(row))}
                      </ReportText>
                    </div>
                  )}
                  {runway(row) !== undefined && (
                    <div>
                      <ReportText as="dt" variant="caption" tone="muted">
                        Runway
                      </ReportText>
                      <ReportText as="dd" variant="amount">
                        {runway(row)?.toFixed(1)} days
                      </ReportText>
                    </div>
                  )}
                </dl>
              </CardContent>
            </Card>
          ))}
        </section>
        <output className="sr-only" aria-live="polite">
          Sorted by {keys[active.id as SortKey]},{" "}
          {active.desc ? "descending" : "ascending"}.
        </output>
      </section>
      {custody.length > 0 && (
        <section className="space-y-3" aria-label="Other accounts">
          <div>
            <ReportText as="h2" variant="section">
              Other accounts
            </ReportText>
            <ReportText variant="caption" tone="muted">
              Custody accounts · ownership not established
            </ReportText>
          </div>
          <Card className="py-0">
            <CardContent className="space-y-4 p-4">
              {custody.map((row) => (
                <div
                  key={row.plane}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <ReportText variant="label">{row.label}</ReportText>
                    <ReportText variant="caption" tone="muted">
                      {row.beneficiary}
                    </ReportText>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <ReportText variant="amount">
                      {rowAmount(row.balance, row.currency)
                        ? amountLabel(rowAmount(row.balance, row.currency))
                        : "Balance unavailable"}
                    </ReportText>
                    <FinanceSource row={row} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}
      <ReportText variant="caption" tone="muted">
        Payment history is not available in this report.
      </ReportText>
    </div>
  );
}
