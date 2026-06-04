// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/credits/loading`
 * Purpose: Per-route Suspense fallback for `/credits`. Mirrors the
 *   2-column AiCreditsPanel + TradingWalletPanel layout on md+.
 *   On mobile, shows a pill-toggle stub above a single tall card.
 * Scope: Server component, layout-preserving.
 * Invariants: Wraps in `PageContainer` to match the actual page.
 * Side-effects: none
 * Links: ./CreditsPage.client.tsx, src/components/kit/layout/CardGridSkeleton.tsx
 * @public
 */

import { PageContainer, Skeleton } from "@/components";
import { CardGridSkeleton } from "@/components/kit/layout/CardGridSkeleton";

export default function CreditsLoading() {
  return (
    <PageContainer maxWidth="2xl">
      {/* Mobile pill-toggle stub — md:hidden mirrors the actual page */}
      <div className="mb-4 flex gap-2 md:hidden">
        <Skeleton className="h-10 flex-1" />
        <Skeleton className="h-10 flex-1" />
      </div>

      {/* Two-col card grid on md+, single card on sm */}
      <CardGridSkeleton
        count={2}
        cols={{ base: 1, md: 2 }}
        cardHeight="h-72"
        gap="gap-6"
      />
    </PageContainer>
  );
}
