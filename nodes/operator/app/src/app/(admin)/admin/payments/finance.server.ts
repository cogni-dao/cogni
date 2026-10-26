// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/finance.server`
 * Purpose: The page's only read path: auth → every reader → one snapshot → Akash collapse → USD projection (ECB) → summary.
 * Scope: Called only behind the existing admin layout; no money-moving authority.
 * Invariants: Auth before any read. The ECB rate is fetched once per snapshot, only when a non-dollar row exists, and under its own deadline.
 *   Telemetry records coverage counts, never balances or credentials.
 * Side-effects: Bounded reader IO, at most one FX read, and one finance.report.read event.
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import "server-only";

import {
  fetchEcbRate,
  summarize,
  takeSnapshot,
  toUsd,
  type UsdRate,
} from "@cogni/money-plane";

import { redirect } from "next/navigation";
import {
  collapseAkash,
  createFinanceReaders,
} from "@/bootstrap/capabilities/finance";
import type { FinanceReportModel } from "@/features/finance/types";
import { getServerSessionUser } from "@/lib/auth/server";
import { getNodeId, isDaoAdmin } from "@/shared/config";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const DOLLAR = new Set(["USD", "USDC"]);
/** Budget for the FX read after the snapshot; a hung rate service leaves rows unconverted, never hangs the report. */
export const FX_TIMEOUT_MS = 5000;

export async function getFinanceReport(): Promise<FinanceReportModel> {
  const user = await getServerSessionUser();
  if (!isDaoAdmin(user?.walletAddress ?? null)) redirect("/dashboard");
  const { readers, treasuryPlane, stewardWalletUrl } =
    await createFinanceReaders();
  const snapshot = await takeSnapshot(readers, { timeoutMs: 5000 });
  const collapsed = collapseAkash(snapshot.rows);
  const foreign = new Set(
    collapsed
      .flatMap((row) => [row, ...(row.children ?? [])])
      .map((row) => row.currency)
      .filter((c): c is string => Boolean(c) && !DOLLAR.has(c as string))
  );
  const fxSignal = AbortSignal.timeout(FX_TIMEOUT_MS);
  const rates = (
    await Promise.all(
      [...foreign].map((currency) =>
        fetchEcbRate(
          (url, init) => fetch(url, { ...init, cache: "no-store" }),
          `${currency}USD`,
          fxSignal
        )
      )
    )
  ).filter((rate): rate is UsdRate => rate !== null);
  const rows = collapsed.map((row) => toUsd(row, rates));
  const summary = summarize({ rows }, { treasuryPlane });
  makeLogger({ route: "admin.payments", nodeId: getNodeId() }).info(
    {
      event: EVENT_NAMES.FINANCE_REPORT_READ,
      rowCount: rows.length,
      unknownCount: rows.filter((row) => row.grade === "UNKNOWN").length,
      transferredRows: rows.filter((row) => row.cumulativeVendorTransfer)
        .length,
      ratesUsed: summary.ratesUsed.map((rate) => rate.pair),
    },
    "Finance report read"
  );
  return { ...snapshot, rows, treasuryPlane, summary, stewardWalletUrl };
}
