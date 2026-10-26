// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceSource`
 * Purpose: Explain one row's evidence in the existing accessible Dialog: source, exact native amounts, basis and cadence, observed time, and the reason when unavailable.
 * Scope: Presentation only; source values stay unrounded and credentials stay server-side.
 * Invariants: No raw reason codes, identifiers, URLs or inferred payments.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
"use client";

import type { ReactNode } from "react";
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
import type { FinanceRow } from "../types";
import {
  attributionLabel,
  balance,
  basisLabel,
  burn,
  nativeLabel,
  observedLabel,
  unavailableReason,
} from "./format";

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <ReportText as="dt" variant="caption" tone="muted">
        {term}
      </ReportText>
      <ReportText as="dd" variant="amount">
        {children}
      </ReportText>
    </div>
  );
}

export function FinanceSource({
  row,
  timeZone,
}: {
  row: FinanceRow;
  /** IANA zone for readable times; undefined uses the viewer's zone. */
  timeZone?: string | undefined;
}) {
  const reason = unavailableReason(row);
  const basis = basisLabel(row);
  const observed = observedLabel(row.sourceObservedAt, timeZone);
  const read = observedLabel(row.observedAt, timeZone);
  const who = attributionLabel(row);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 shrink-0 text-xs"
          aria-label={`${row.label} source`}
        >
          Source
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-dvh w-11/12 min-w-0 max-w-lg overflow-y-auto break-words [&>button]:top-1 [&>button]:right-1 [&>button]:grid [&>button]:size-11 [&>button]:place-items-center">
        <DialogHeader className="pr-8">
          <DialogTitle>{row.label}</DialogTitle>
          <DialogDescription>
            {row.source ?? "Not connected"}
            {basis ? ` · ${basis}` : ""}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid min-w-0 gap-4">
          {reason && (
            <Fact term="Unavailable">
              {reason}
              {row.detail && row.detail !== reason ? (
                <ReportText as="span" variant="caption" tone="muted">
                  {" "}
                  · {row.detail}
                </ReportText>
              ) : null}
            </Fact>
          )}
          {balance(row) !== undefined && (
            <Fact term="Balance · exact">
              {row.balance} {row.currency}
            </Fact>
          )}
          {row.parts?.map((part) => (
            <Fact key={part.label} term={`${part.label} · exact`}>
              {nativeLabel(part.amount, part.currency)}
            </Fact>
          ))}
          {row.nativeRate && (
            <Fact term="Native rate · exact">
              {row.nativeRate.amount} {row.nativeRate.currency} /{" "}
              {row.nativeRate.per}
            </Fact>
          )}
          {burn(row) !== undefined && (
            <Fact term="Burn per day">
              {row.burnPerDay} {row.currency}
            </Fact>
          )}
          {!reason && row.detail && <Fact term="Note">{row.detail}</Fact>}
          <Fact term="Observed">
            {observed ?? `Source time unknown · read ${read ?? "—"}`}
          </Fact>
          {who && <Fact term="Who pays">{who}</Fact>}
          {row.cumulativeVendorTransfer && (
            <Fact term="Provider transfers · cumulative">
              {nativeLabel(
                row.cumulativeVendorTransfer.amount,
                row.cumulativeVendorTransfer.currency
              )}
            </Fact>
          )}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
