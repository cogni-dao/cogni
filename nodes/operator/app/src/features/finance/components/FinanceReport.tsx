// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceReport`
 * Purpose: Read-only DAO finance table from the shared reporting contract.
 * Scope: Presentation only; no reads, credentials, payment actions or FX conversion.
 * Invariants: Missing evidence is visible. Custody, rates and cumulative transfers remain separate.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */

import type { MoneyPlaneRow, MoneyPlaneSnapshot } from "@cogni/money-plane";
import type { ReactElement } from "react";

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";

function money(value: number | null, currency: string | null): string {
  if (value === null || !Number.isFinite(value) || !currency)
    return "Not available";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${currency}`;
}

function rate(row: MoneyPlaneRow): string {
  if (row.nativeRate) {
    return `${row.nativeRate.amount} ${row.nativeRate.currency} / ${row.nativeRate.per}`;
  }
  return row.burnPerDay === null
    ? "Not measured"
    : `${money(row.burnPerDay, row.currency)} / day`;
}

function timestamp(value: string | null | undefined): string {
  if (!value) return "Source age unknown";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "Source age unknown";
}

const kinds: Record<MoneyPlaneRow["kind"], string> = {
  prepaid: "Prepaid service",
  usage: "Usage billed",
  fixed: "Subscription",
  expiry: "Renewal",
  wallet: "Wallet holdings",
};

export function FinanceReport({
  report,
}: {
  report: MoneyPlaneSnapshot;
}): ReactElement {
  const transfers = report.rows.filter((row) => row.cumulativeVendorTransfer);
  const unknown = report.rows.filter((row) => row.grade === "UNKNOWN").length;
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
            DAO finances
          </p>
          <h1 className="font-semibold text-3xl tracking-tight">
            Where the money goes
          </h1>
          <p className="max-w-2xl text-muted-foreground text-sm">
            Costs, funding and the evidence behind them. The operator currently
            covers node expenses.
          </p>
        </div>
        <Badge intent="outline">Read only</Badge>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">Reported sources</p>
          <p className="mt-1 font-semibold text-2xl tabular-nums">
            {report.rows.length}
          </p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">Need more evidence</p>
          <p className="mt-1 font-semibold text-2xl tabular-nums">{unknown}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">Report fetched</p>
          <p className="mt-2 font-medium text-sm">
            {timestamp(report.takenAt)}
          </p>
        </div>
      </div>

      <section aria-label="Costs and funding" className="space-y-3">
        <div>
          <h2 className="font-semibold text-lg">Costs & funding</h2>
          <p className="text-muted-foreground text-sm">
            Native currencies stay separate. A wallet balance is not a spending
            allowance.
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service / account</TableHead>
                <TableHead>Who pays / benefits</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead>Burn / native rate</TableHead>
                <TableHead>Runway</TableHead>
                <TableHead>Grade & evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((row) => (
                <TableRow key={row.plane}>
                  <TableCell>
                    <div className="min-w-40 font-medium">{row.label}</div>
                    <div className="text-muted-foreground text-xs">
                      {kinds[row.kind]}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{row.payer ?? "Payer not established"}</div>
                    <div className="max-w-56 break-words text-muted-foreground text-xs">
                      {row.beneficiary ?? "Beneficiary not established"}
                    </div>
                    {row.coverage === "operator-covered" && (
                      <div className="text-muted-foreground text-xs">
                        Operator covered
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {money(row.balance, row.currency)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {rate(row)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {row.kind === "wallet"
                      ? "Not applicable"
                      : row.runwayDays === null ||
                          !Number.isFinite(row.runwayDays)
                        ? "Not available"
                        : `${row.runwayDays.toFixed(1)} days`}
                  </TableCell>
                  <TableCell>
                    <Badge
                      intent={row.grade === "RED" ? "destructive" : "outline"}
                      size="sm"
                    >
                      {row.grade}
                    </Badge>
                    <div className="mt-1 max-w-64 text-muted-foreground text-xs">
                      {row.detail ??
                        (row.reasonCode === "burn_unmeasured"
                          ? "Burn has not been measured"
                          : null)}
                    </div>
                    <div className="mt-1 text-muted-foreground text-xs">
                      {row.source ?? "Source unavailable"}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {row.freshness === "stale" ? "Stale · " : ""}
                      {timestamp(row.sourceObservedAt)}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section aria-label="Payment evidence" className="space-y-3">
        <div>
          <h2 className="font-semibold text-lg">Payment evidence</h2>
          <p className="text-muted-foreground text-sm">
            Cumulative provider transfers from existing cost records. Individual
            payment history is not available in this report.
          </p>
        </div>
        {transfers.length ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service / beneficiary</TableHead>
                  <TableHead>Transferred to provider</TableHead>
                  <TableHead>Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transfers.map((row) => (
                  <TableRow key={row.plane}>
                    <TableCell>
                      {row.label}
                      <div className="text-muted-foreground text-xs">
                        {row.beneficiary}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.cumulativeVendorTransfer?.amount}{" "}
                      {row.cumulativeVendorTransfer?.currency}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      Cumulative record · {timestamp(row.sourceObservedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="rounded-lg border p-5 text-muted-foreground text-sm">
            Payment evidence is unavailable. This does not mean no payments were
            made.
          </p>
        )}
      </section>
      <p className="max-w-3xl text-muted-foreground text-xs">
        This is a partial report of configured sources. Unknown amounts are not
        zero. Treasury, operator working capital and human-custodied funds are
        shown separately; no combined cash or expense total is inferred.
      </p>
    </div>
  );
}
