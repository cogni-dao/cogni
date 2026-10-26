// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/finance.server`
 * Purpose: Read-only page composition of the shared finance reporting service.
 * Scope: Called only behind the existing admin layout; no money-moving authority.
 * Invariants: Telemetry records coverage counts, never balances or credentials.
 * Side-effects: Bounded reader IO and one finance.report.read event.
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import "server-only";

import { takeSnapshot } from "@cogni/money-plane";

import { redirect } from "next/navigation";
import { createFinanceReaders } from "@/bootstrap/capabilities/finance";
import type { FinanceReportModel } from "@/features/finance/types";
import { getServerSessionUser } from "@/lib/auth/server";
import { getNodeId, isDaoAdmin } from "@/shared/config";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

export async function getFinanceReport(): Promise<FinanceReportModel> {
  const user = await getServerSessionUser();
  if (!isDaoAdmin(user?.walletAddress ?? null)) redirect("/dashboard");
  const { readers, treasuryPlane, configuredWalletPlanes, costRateEvidence } =
    await createFinanceReaders();
  const report = await takeSnapshot(readers, {
    timeoutMs: 5000,
  });
  makeLogger({ route: "admin.payments", nodeId: getNodeId() }).info(
    {
      event: EVENT_NAMES.FINANCE_REPORT_READ,
      rowCount: report.rows.length,
      unknownCount: report.rows.filter((row) => row.grade === "UNKNOWN").length,
      transferredRows: report.rows.filter((row) => row.cumulativeVendorTransfer)
        .length,
    },
    "Finance report read"
  );
  return { ...report, treasuryPlane, configuredWalletPlanes, costRateEvidence };
}
