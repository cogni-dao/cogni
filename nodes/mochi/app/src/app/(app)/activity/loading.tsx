// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/activity/loading`
 * Purpose: Per-route Suspense fallback for `/activity`. Mirrors the
 *   range-selector + 3-column charts row + activity table layout.
 * Scope: Server component, layout-preserving.
 * Side-effects: none
 * Links: ./page.tsx, src/components/kit/layout/CardGridSkeleton.tsx, src/components/kit/layout/TableSkeleton.tsx
 * @public
 */

import { Skeleton } from "@/components";
import { CardGridSkeleton } from "@/components/kit/layout/CardGridSkeleton";
import { PageHeaderSkeleton } from "@/components/kit/layout/PageHeaderSkeleton";
import { TableSkeleton } from "@/components/kit/layout/TableSkeleton";

export default function ActivityLoading() {
  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <PageHeaderSkeleton titleWidth="w-32" />

      {/* Range selector + group-by toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-10 w-48" />
      </div>

      {/* 3-card chart row on md+, stacked on sm */}
      <CardGridSkeleton count={3} cols={{ base: 1, md: 3 }} cardHeight="h-48" />

      {/* Activity table */}
      <TableSkeleton rows={8} />
    </div>
  );
}
