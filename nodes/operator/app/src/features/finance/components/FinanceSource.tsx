// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceSource`
 * Purpose: The Line label is the trigger: one accessible Dialog per row with source, exact native amounts, basis, observed time, who pays, and the reason when unavailable.
 * Scope: Presentation only; source values stay unrounded and credentials stay server-side.
 * Invariants: ≤ 6 short rows; no raw reason codes, identifiers, URLs or inferred payments.
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
  balance,
  basisLabel,
  burn,
  nativeLabel,
  observedLabel,
  payerLabel,
  unavailableReason,
  whoPaysLabel,
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
  const who = whoPaysLabel(row);
  const payer = payerLabel(row);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="link"
          size="sm"
          className="h-auto min-w-0 flex-col items-start whitespace-normal p-0 text-left text-foreground no-underline hover:underline"
          aria-label={row.label}
        >
          <ReportText as="span" variant="label" className="block">
            {row.label}
          </ReportText>
          {payer && (
            <ReportText
              as="span"
              variant="caption"
              tone="muted"
              className="block"
            >
              {payer}
            </ReportText>
          )}
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
        <dl className="grid min-w-0 gap-3">
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
          {row.note && <Fact term="Note">{row.note}</Fact>}
          {row.parts?.length
            ? row.parts.map((part) => (
                <Fact key={part.label} term={part.label}>
                  {nativeLabel(part.amount, part.currency)}
                </Fact>
              ))
            : balance(row) !== undefined && (
                <Fact term="Balance · exact">
                  {row.balance} {row.currency}
                </Fact>
              )}
          {row.nativeRate ? (
            <Fact term="Rate · exact">
              {row.nativeRate.amount} {row.nativeRate.currency} /{" "}
              {row.nativeRate.per}
            </Fact>
          ) : (
            burn(row) !== undefined && (
              <Fact term="Burn / day">
                {row.burnPerDay} {row.currency}
              </Fact>
            )
          )}
          {!reason && row.detail && <Fact term="Detail">{row.detail}</Fact>}
          <Fact term="Observed">
            {observed ?? `Source time unknown · read ${read ?? "—"}`}
          </Fact>
          {who && <Fact term="Who pays">{who}</Fact>}
          {row.cumulativeVendorTransfer && (
            <Fact term="Transfers · cumulative">
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
