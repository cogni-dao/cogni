// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/loading`
 * Purpose: Per-route Suspense fallback for `/work`. Mirrors the work
 *   dashboard — title + faceted-filter toolbar + DataGrid + pagination.
 * Scope: Server component, layout-preserving inside `(app)/layout.tsx`.
 * Invariants: Outer container matches `view.tsx` (`flex flex-col gap-4
 *   p-5 md:p-6`). Toolbar wraps on small screens; table scrolls.
 * Side-effects: none
 * Links: ./view.tsx, src/components/kit/layout/TableSkeleton.tsx
 * @public
 */

import { Skeleton } from "@/components";
import { PageHeaderSkeleton } from "@/components/kit/layout/PageHeaderSkeleton";
import { TableSkeleton } from "@/components/kit/layout/TableSkeleton";

export default function WorkLoading() {
  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <PageHeaderSkeleton titleWidth="w-32" />

      {/* Faceted filter / search toolbar — wraps on sm */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full sm:w-72" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>

      <TableSkeleton rows={12} withPagination />
    </div>
  );
}
