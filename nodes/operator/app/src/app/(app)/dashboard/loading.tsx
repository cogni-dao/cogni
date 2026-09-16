// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Layout-preserving fallback for the node-first dashboard. */

export default function DashboardLoading() {
  return (
    <div className="flex animate-pulse flex-col gap-8 p-4 sm:p-5 md:p-6">
      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div className="space-y-2">
            <div className="h-8 w-36 rounded bg-muted" />
            <div className="h-4 w-56 rounded bg-muted" />
          </div>
          <div className="h-11 w-28 rounded-md bg-muted" />
        </div>
        <div className="overflow-hidden rounded-lg border">
          <div className="h-11 border-b bg-muted/50" />
          <div className="h-20 border-b bg-muted/30" />
          <div className="h-20 bg-muted/30" />
        </div>
      </section>
      <div className="h-14 rounded-lg border bg-muted/20" />
    </div>
  );
}
