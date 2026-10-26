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
  FinanceReport,
  StewardWithdrawalRejected,
} from "@cogni/money-plane/react";
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

/**
 * POST the amount-only steward withdrawal. An explicit JSON refusal throws `StewardWithdrawalRejected` (nothing was sent,
 * retry allowed); a transport failure or a non-JSON body throws a plain Error (outcome unknown; the control locks).
 */
export async function fundSteward(
  amountUsd: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ txHash: string | null }> {
  const res = await fetchImpl(STEWARD_WITHDRAWAL_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUsd }),
  });
  let data: { txHash?: string; error?: string; detail?: string; code?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new Error(`Response unreadable (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const reason = data.detail ?? data.error ?? data.code;
    if (reason) throw new StewardWithdrawalRejected(reason);
    throw new Error(`HTTP ${res.status}`);
  }
  return { txHash: data.txHash ?? null };
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
}: {
  report: FinanceReportModel;
}) {
  const router = useRouter();
  return (
    <FinanceReport
      report={report}
      summary={report.summary}
      kit={kit}
      actions={{
        fundSteward: (amount) => fundSteward(amount),
        refresh: () => router.refresh(),
      }}
      thisNode="Operator"
    />
  );
}
