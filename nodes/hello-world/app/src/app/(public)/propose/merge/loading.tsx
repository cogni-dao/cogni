// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/propose/merge/loading`
 * Purpose: Per-route Suspense fallback for `/propose/merge`. Overrides
 *   the parent `(public)/loading.tsx` (which is shaped like the landing
 *   page) so the form route paints a form-shaped skeleton.
 * Scope: Server component, layout-preserving.
 * Invariants: PageHeader + 4 labeled input rows + button row.
 * Side-effects: none
 * Links: ./page.tsx, src/components/kit/layout/PageHeaderSkeleton.tsx
 * @public
 */

import { Skeleton } from "@/components";
import { PageHeaderSkeleton } from "@/components/kit/layout/PageHeaderSkeleton";

export default function ProposeMergeLoading() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <PageHeaderSkeleton
        titleWidth="w-72"
        withSubtitle
        subtitleWidth="w-2/3"
      />

      {/* Form — 4 labeled input rows */}
      <div className="flex flex-col gap-5">
        {Array.from({ length: 4 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: form skeleton rows are static
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>

      {/* Submit button row */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-40" />
      </div>
    </div>
  );
}
