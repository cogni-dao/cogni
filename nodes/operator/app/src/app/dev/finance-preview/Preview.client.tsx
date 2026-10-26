// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/dev/finance-preview/Preview.client`
 * Purpose: Isolate the complete real admin shell from live treasury queries in fixture previews.
 * Scope: Development route only; static same-fixture treasury seed and independent query cache.
 * Invariants: Treasury query stays disabled across staleness, focus and invalidation.
 * Side-effects: No live financial IO.
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
"use client";
import type { TreasurySnapshotResponseV1 } from "@cogni/node-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { AdminShell } from "@/app/(admin)/AdminShell";
import {
  PageContainer,
  ReportText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import { FinanceReport } from "@/features/finance/components/FinanceReport";
import type { FinanceReportModel } from "@/features/finance/types";
import { CHAINS } from "@/shared/web3";
import {
  financePreview,
  longFinancePreview,
  missingFinancePreview,
  previewTreasuryAddress,
  richFinancePreview,
} from "./fixture";

export function FixtureQueryBoundary({
  report,
  children,
}: {
  report: FinanceReportModel;
  children: ReactNode;
}) {
  const [client] = useState(() => {
    const value = new QueryClient();
    value.setQueryDefaults(["treasury", "snapshot"], { enabled: false });
    const treasury = report.rows.find(
      (row) =>
        row.plane === report.treasuryPlane &&
        report.configuredWalletPlanes.includes(row.plane)
    );
    if (
      treasury?.currency === "USDC" &&
      treasury.balance !== null &&
      Number.isFinite(treasury.balance) &&
      treasury.balance >= 0
    ) {
      const snapshot: TreasurySnapshotResponseV1 = {
        treasuryAddress: previewTreasuryAddress,
        chainId: CHAINS.BASE.chainId,
        blockNumber: "0",
        timestamp: Date.parse(report.takenAt),
        balances: [
          {
            token: "USDC",
            tokenAddress: CHAINS.BASE.usdcTokenAddress,
            decimals: 6,
            balanceWei: String(Math.round(treasury.balance * 1e6)),
            balanceFormatted: String(treasury.balance),
          },
        ],
      };
      value.setQueryData(["treasury", "snapshot"], snapshot);
    }
    return value;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const scenarios = {
  current: financePreview,
  sparse: missingFinancePreview,
  rich: richFinancePreview,
  long: longFinancePreview,
};
export function FinancePreview() {
  const [scenario, setScenario] = useState<keyof typeof scenarios>("current");
  const report = scenarios[scenario];
  return (
    <FixtureQueryBoundary key={scenario} report={report}>
      <AdminShell>
        <PageContainer maxWidth="full">
          <div className="mx-auto w-full min-w-0 max-w-6xl space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ReportText variant="caption" tone="muted">
                Demo data ·{" "}
                {scenario === "rich" || scenario === "long"
                  ? "synthetic measured examples"
                  : "source-shaped reporting example"}
              </ReportText>
              <Select
                value={scenario}
                onValueChange={(value) =>
                  setScenario(value as keyof typeof scenarios)
                }
              >
                <SelectTrigger
                  aria-label="Preview scenario"
                  className="min-h-11 w-full max-w-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">
                    Current source coverage
                  </SelectItem>
                  <SelectItem value="sparse">
                    Missing treasury and costs
                  </SelectItem>
                  <SelectItem value="rich">
                    Synthetic measured examples
                  </SelectItem>
                  <SelectItem value="long">Synthetic edge cases</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FinanceReport report={report} />
          </div>
        </PageContainer>
      </AdminShell>
    </FixtureQueryBoundary>
  );
}
