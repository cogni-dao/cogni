// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/layout/TableSkeleton`
 * Purpose: Reusable data-table skeleton — renders a header row, N body
 *   rows, and an optional pagination footer. Sized to match the codebase's
 *   ReUI / TanStack data-grid renders so there's no shape pop between
 *   skeleton and content.
 * Scope: Composable layout primitive for `loading.tsx` files on routes
 *   whose dominant element is a full-width table (work, research, gov,
 *   schedules).
 * Invariants:
 *   - Header row uses `h-9` to match `<TableHead>` row height.
 *   - Body rows use `h-12` to match the typical cell-padding × text-sm row.
 *   - Pagination row uses `h-9` to match `DataGridPagination`.
 * Side-effects: none
 * Links: src/components/reui/data-grid/data-grid-table.tsx, src/components/vendor/shadcn/skeleton.tsx
 * @public
 */

import { Skeleton } from "@cogni/node-ui-kit/shadcn/skeleton";

interface TableSkeletonProps {
  /** Number of body rows to render. Default: `8`. */
  readonly rows?: number;
  /** Render a pagination footer row. Default: `false`. */
  readonly withPagination?: boolean;
  /** Render a toolbar row above the header. Default: `false`. */
  readonly withToolbar?: boolean;
}

export function TableSkeleton({
  rows = 8,
  withPagination = false,
  withToolbar = false,
}: TableSkeletonProps) {
  return (
    <div className="flex flex-col gap-2">
      {withToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-full sm:w-72" />
          <Skeleton className="h-9 w-32" />
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border">
        <Skeleton className="h-9 w-full rounded-none" />
        <div className="divide-y divide-border">
          {Array.from({ length: rows }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows are static placeholders, not data
            <Skeleton key={i} className="h-12 w-full rounded-none" />
          ))}
        </div>
        {withPagination ? (
          <Skeleton className="h-9 w-full rounded-none" />
        ) : null}
      </div>
    </div>
  );
}
