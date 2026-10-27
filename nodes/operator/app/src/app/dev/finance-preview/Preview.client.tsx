// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/dev/finance-preview/Preview.client`
 * Purpose: Render the /admin/payments report inside the real admin shell on fixture data, isolated from live treasury queries.
 * Scope: Development route only; static same-fixture treasury seed and independent query cache.
 * Invariants: Treasury query stays disabled across staleness, focus and invalidation. Fixture-owned actions
 *   cannot POST or refresh live data; checkout links are removed. No fake funding success.
 * Side-effects: No live financial IO.
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
"use client";
import {
  type MoneyPlaneRow,
  StewardWithdrawalRejected,
} from "@cogni/money-plane";
import type { FinanceActions } from "@cogni/money-plane/react";
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
import { FinanceReportClient } from "@/features/finance/components/FinanceReportClient";
import type { FinanceReportModel } from "@/features/finance/types";
import { CHAINS } from "@/shared/web3";
import {
  liveShapedFinancePreview,
  previewTreasuryAddress,
  sparseFinancePreview,
  withIncomeFinancePreview,
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
      (row) => row.plane === report.treasuryPlane
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

const demoActions: FinanceActions = {
  async fundSteward() {
    throw new StewardWithdrawalRejected("Demo only · no payments");
  },
  refresh() {},
};

function demoRow(row: MoneyPlaneRow): MoneyPlaneRow {
  const children = row.children?.map(demoRow);
  const withChildren = children ? { ...row, children } : row;
  if (!row.payAction || row.payAction.kind === "fund-steward")
    return withChildren;
  const { payAction: _checkout, ...withoutCheckout } = withChildren;
  return {
    ...withoutCheckout,
    rail: { kind: row.rail?.kind ?? "none", status: "unsupported" },
    note: "Demo only · payments disabled",
  };
}

const scenarios = {
  "live-shaped": liveShapedFinancePreview,
  "with-income": withIncomeFinancePreview,
  sparse: sparseFinancePreview,
};
type Scenario = keyof typeof scenarios;

export function FinancePreview() {
  const [scenario, setScenario] = useState<Scenario>("live-shaped");
  const report = scenarios[scenario];
  return (
    <FixtureQueryBoundary key={scenario} report={report}>
      <AdminShell>
        <PageContainer maxWidth="full">
          <div className="w-full min-w-0 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ReportText variant="caption" tone="muted">
                Demo data · {scenario}
              </ReportText>
              <Select
                value={scenario}
                onValueChange={(value) => setScenario(value as Scenario)}
              >
                <SelectTrigger
                  aria-label="Preview scenario"
                  className="min-h-11 w-full max-w-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="live-shaped">Live-shaped</SelectItem>
                  <SelectItem value="with-income">With income</SelectItem>
                  <SelectItem value="sparse">
                    Sparse · RPC down, no keys
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FinanceReportClient
              report={{ ...report, rows: report.rows.map(demoRow) }}
              actions={demoActions}
            />
          </div>
        </PageContainer>
      </AdminShell>
    </FixtureQueryBoundary>
  );
}
