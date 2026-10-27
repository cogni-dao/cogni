// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/FinanceReportClient`
 * Purpose: Bind the package FinanceReport (ONE_UI) to this node: its UI kit, its routes (steward withdrawal POST, router.refresh).
 * Scope: Client component. No table logic here; the package owns layout, grouping, dialogs and rail rendering.
 * Invariants: The only write stays `POST /api/v1/payments/steward-withdrawal` (AMOUNT_ONLY; destination pinned server-side).
 * Side-effects: IO (fetch POST → on-chain transfer) on user click; route refresh on request.
 * Links: @cogni/money-plane/react, src/app/api/v1/payments/steward-withdrawal/route.ts
 * @public
 */
"use client";

import {
  readStewardWithdrawal,
  StewardWithdrawalRejected,
} from "@cogni/money-plane";
import { type FinanceActions, FinanceReport } from "@cogni/money-plane/react";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
} from "@/components";
import type { FinanceReportModel } from "../types";

export const STEWARD_WITHDRAWAL_PATH = "/api/v1/payments/steward-withdrawal";
/** A hung socket must land in the "check BaseScan" path, not an endless "Funding…". */
export const STEWARD_WITHDRAWAL_TIMEOUT_MS = 20_000;

/**
 * POST the amount-only steward withdrawal.
 * - A valid transaction hash always survives; HTTP errors or missing receipt status stay pending.
 * - Without a hash, refusals that are pre-broadcast by construction — 400 (invalid body), 403 (not the steward), 503 with an
 *   `*_UNCONFIGURED` code — throw `StewardWithdrawalRejected` (nothing was sent; retry allowed).
 * - Everything else (422, 5xx, non-JSON body, timeout, transport failure) is an unknown outcome: plain Error carrying
 *   the server's `detail` when present; the control locks until a human checks the wallet (NO_BLIND_RETRY).
 */
export async function fundSteward(
  amountUsd: number,
  fetchImpl: typeof fetch = fetch
): Promise<{
  txHash: string;
  receiptStatus: "success" | "reverted" | "pending";
}> {
  const res = await fetchImpl(STEWARD_WITHDRAWAL_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUsd }),
    signal: AbortSignal.timeout(STEWARD_WITHDRAWAL_TIMEOUT_MS),
  });
  let data: {
    error?: string;
    detail?: string;
    code?: string;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new Error(`Response unreadable (HTTP ${res.status})`);
  }
  // A known broadcast hash wins over HTTP/refusal labels. Preserve its evidence
  // and retry lock even when the response cannot establish receipt status.
  const outcome = readStewardWithdrawal(data);
  if (outcome)
    return res.ok ? outcome : { ...outcome, receiptStatus: "pending" };
  if (res.ok) throw new Error("Withdrawal result incomplete");
  const reason = data.detail ?? data.error ?? data.code ?? `HTTP ${res.status}`;
  const preBroadcast =
    res.status === 400 ||
    res.status === 403 ||
    (res.status === 503 && /_UNCONFIGURED$/.test(data.code ?? ""));
  if (preBroadcast) throw new StewardWithdrawalRejected(reason);
  throw new Error(`${reason} (HTTP ${res.status})`);
}

const kit = {
  Button,
  Input,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
};

export function FinanceReportClient({
  report,
  actions,
}: {
  report: FinanceReportModel;
  /** Development fixtures supply inert actions; the admin page uses defaults. */
  actions?: FinanceActions;
}) {
  const router = useRouter();
  return (
    <FinanceReport
      report={report}
      summary={report.summary}
      kit={kit}
      actions={
        actions ?? {
          fundSteward: (amount) => fundSteward(amount),
          refresh: () => router.refresh(),
        }
      }
      thisNode="Operator"
    />
  );
}
