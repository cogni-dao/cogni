// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/metrics/loading`
 * Purpose: Per-route Suspense fallback for `/metrics`: the page header and card-shaped placeholders while the server seeds the goal read.
 * Scope: Server component mirroring `view.tsx`'s shell. No data.
 * Side-effects: none
 * Links: ./view.tsx
 * @public
 */

import { PageHeaderSkeleton } from "@/components/kit/layout/PageHeaderSkeleton";

export default function MetricsLoading() {
  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <PageHeaderSkeleton titleWidth="w-32" />
      <div aria-hidden="true" className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}
