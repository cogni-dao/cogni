// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/metrics/view`
 * Purpose: The Metrics page shell: title, then the package's whole Metrics view (story.0039).
 * Scope: Composition only. `@cogni/knowledge-base-ui/goals` owns the board, the ordering and every control; this node supplies the page header and its host (Next `Link`).
 * Invariants: No Metrics markup, grouping, sorting or fetching lives in the app (extraction is mechanical: this file is the whole node-local part).
 * Side-effects: none
 * Links: ./_components/MetricsMount.tsx
 * @public
 */

"use client";

import type { GoalsProgress } from "@cogni-dao/metrics/contracts";

import { MetricsMount } from "./_components/MetricsMount";

export function MetricsView({
  initialData,
}: {
  readonly initialData?: GoalsProgress | undefined;
}) {
  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
          Metrics
        </h1>
      </div>
      <MetricsMount initialData={initialData} />
    </div>
  );
}
