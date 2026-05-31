// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/loading`
 * Purpose: Suspense fallback for the `(public)` route group. Optimised
 *   for the landing page (`/`) — the dominant route — so it mirrors the
 *   marketing layout (Hero + MarketCards + BrainFeed). Sub-routes whose
 *   shape differs (propose/merge form) override with their own
 *   per-route `loading.tsx`.
 * Scope: Server component, layout-preserving.
 * Invariants: Mirrors `(public)/page.tsx` macro shape — Hero block,
 *   3-card responsive MarketCards row, BrainFeed list rows. Stacks to
 *   single column on mobile.
 * Side-effects: none
 * Links: ./page.tsx, src/components/Hero.tsx, src/components/MarketCards.tsx,
 *   src/components/BrainFeed.tsx,
 *   https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming
 * @public
 */

import { Skeleton } from "@/components";
import { CardGridSkeleton } from "@/components/kit/layout/CardGridSkeleton";

export default function PublicLoading() {
  return (
    <div className="flex min-h-screen flex-col gap-12 p-6 md:p-12">
      {/* Hero */}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-1/2" />
        <div className="mt-4 flex gap-3">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-32" />
        </div>
      </div>

      {/* MarketCards — 3-card row on md+, stacked on sm */}
      <CardGridSkeleton count={3} cols={{ base: 1, md: 3 }} cardHeight="h-32" />

      {/* BrainFeed — 3 list rows */}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    </div>
  );
}
