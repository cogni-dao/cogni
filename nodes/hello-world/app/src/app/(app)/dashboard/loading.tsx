// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/loading`
 * Purpose: Per-route Suspense fallback for `/dashboard`. Mirrors the
 *   actual page macro layout — header + 4 stacked full-width cards
 *   (TradingWallet, OperatorWalletCharts, ExecutionActivity, WalletQuickJump)
 *   + 2-col grid (Recent Runs, Active Work) + 3-col charts row.
 * Scope: Server component, layout-preserving inside `(app)/layout.tsx`.
 * Invariants: Matches `view.tsx` shell — outer `flex flex-col gap-6 p-5
 *   md:p-6`, then the four sections in order. Mobile stacks all grids
 *   to single column; desktop renders 2-col / 3-col where the page does.
 * Side-effects: none
 * Links: ./view.tsx, src/components/kit/layout/CardGridSkeleton.tsx, src/components/kit/layout/PageHeaderSkeleton.tsx
 * @public
 */

import { CardGridSkeleton } from "@/components/kit/layout/CardGridSkeleton";
import { PageHeaderSkeleton } from "@/components/kit/layout/PageHeaderSkeleton";

export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6 p-5 md:p-6">
      <PageHeaderSkeleton titleWidth="w-44" />

      {/* Polymarket primary section — 4 full-width cards stacked */}
      <CardGridSkeleton count={4} cols={{ base: 1 }} cardHeight="h-32" />

      {/* Two-column grid: Agents + Work — stacks on sm */}
      <CardGridSkeleton
        count={2}
        cols={{ base: 1, lg: 2 }}
        cardHeight="h-48"
        gap="gap-6"
      />

      {/* Activity section: 3-card chart row, stacks on sm */}
      <CardGridSkeleton count={3} cols={{ base: 1, md: 3 }} cardHeight="h-48" />
    </div>
  );
}
