// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceSource`
 * Purpose: Explain relevant financial evidence in one accessible source dialog.
 * Scope: Presentation only; source values stay unrounded and credentials stay server-side.
 * Invariants: No technical identifier dump, inferred payments or nested disclosures.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
"use client";

import type { CostRateEvidence, MoneyPlaneRow } from "@cogni/money-plane";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ReportText,
} from "@/components";
import { nativeBurn, observedLabel, rowAmount } from "./format";

export function sourceExplanation(row: MoneyPlaneRow): string {
  if (row.plane.includes("openrouter") || row.plane.includes("cherry:account"))
    return "Operator-funded · provider balance access not connected.";
  if (row.kind === "wallet")
    return rowAmount(row.balance, row.currency)
      ? "Observed holding · custody does not establish spending authority."
      : "Configured account · balance unavailable.";
  if (row.nativeRate) return "Contract quote · not measured spend.";
  if (row.burnPerDay !== null)
    return "Reported rate · see the stated measurement interval where available.";
  if (row.cumulativeVendorTransfer)
    return "Provider transfers · period and completeness unknown.";
  return "Operator-funded · cost not yet reported.";
}

export function hasSourceEvidence(row: MoneyPlaneRow): boolean {
  return Boolean(
    row.kind === "wallet" ||
      rowAmount(row.balance, row.currency) ||
      nativeBurn(row) ||
      row.cumulativeVendorTransfer ||
      row.plane.includes("openrouter") ||
      row.plane.includes("cherry:account")
  );
}

export function FinanceSource({
  row,
  evidence,
}: {
  row: MoneyPlaneRow;
  evidence?: CostRateEvidence | undefined;
}) {
  if (!hasSourceEvidence(row)) return null;
  const balance = rowAmount(row.balance, row.currency);
  const rate = nativeBurn(row);
  const observed = observedLabel(row.sourceObservedAt, true);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 shrink-0"
          aria-label={`${row.label} source${row.kind !== "wallet" && row.beneficiary ? ` — ${row.beneficiary}` : ""}`}
        >
          Source
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-dvh w-11/12 min-w-0 max-w-lg overflow-y-auto break-words [&>button]:top-1 [&>button]:right-1 [&>button]:grid [&>button]:size-11 [&>button]:place-items-center">
        <DialogHeader className="pr-8">
          <DialogTitle>{row.label} source</DialogTitle>
          <DialogDescription>{sourceExplanation(row)}</DialogDescription>
        </DialogHeader>
        <dl className="grid min-w-0 gap-4">
          {balance && (
            <div>
              <ReportText as="dt" tone="muted">
                Account balance
              </ReportText>
              <ReportText as="dd" variant="amount">
                {balance.amount} {balance.currency}
              </ReportText>
            </div>
          )}
          {rate && (
            <div>
              <ReportText as="dt" tone="muted">
                {evidence?.basis.kind === "contract"
                  ? "Contract rate"
                  : evidence?.basis.kind === "measured"
                    ? "Measured burn"
                    : "Reported rate"}
              </ReportText>
              <ReportText as="dd" variant="amount">
                {rate.amount} {rate.currency} / {rate.per}
              </ReportText>
              {rate.currency === "uact" && (
                <ReportText as="dd" tone="muted">
                  1,000,000 uact = 1 ACT of USD compute credit; not transferable
                  cash.
                </ReportText>
              )}
            </div>
          )}
          {(balance || rate) && (
            <div>
              <ReportText as="dt" tone="muted">
                {balance ? "Balance observed" : "Rate observed"}
              </ReportText>
              <ReportText as="dd">
                {observed === "Unknown"
                  ? "Source age unknown"
                  : `${observed}${row.freshness === "stale" ? " · Stale" : ""}`}
              </ReportText>
            </div>
          )}
          {evidence?.basis.kind === "measured" && (
            <div>
              <ReportText as="dt" tone="muted">
                Measurement interval
              </ReportText>
              <ReportText as="dd">
                {observedLabel(evidence.basis.start, true)} –{" "}
                {observedLabel(evidence.basis.end, true)}
              </ReportText>
            </div>
          )}
          {row.payer && row.payer !== "Not established" && (
            <div>
              <ReportText as="dt" tone="muted">
                Funded by
              </ReportText>
              <ReportText as="dd">{row.payer}</ReportText>
            </div>
          )}
          {row.beneficiary && (
            <div>
              <ReportText as="dt" tone="muted">
                {row.kind === "wallet" ? "Configured roles" : "Service scope"}
              </ReportText>
              <ReportText as="dd">{row.beneficiary}</ReportText>
            </div>
          )}
          {row.source && row.source !== "Not connected" && (
            <div>
              <ReportText as="dt" tone="muted">
                Source
              </ReportText>
              <ReportText as="dd">{row.source}</ReportText>
            </div>
          )}
          {row.cumulativeVendorTransfer && (
            <div>
              <ReportText as="dt" tone="muted">
                Provider transfers · cumulative
              </ReportText>
              <ReportText as="dd" variant="amount">
                {row.cumulativeVendorTransfer.amount}{" "}
                {row.cumulativeVendorTransfer.currency}
              </ReportText>
              <ReportText as="dd" tone="muted">
                Period/completeness unknown · not expense or payment history.
              </ReportText>
            </div>
          )}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
