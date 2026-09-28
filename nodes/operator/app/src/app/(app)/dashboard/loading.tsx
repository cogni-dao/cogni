// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Layout-preserving fallback for the node-first dashboard. */

export default function DashboardLoading() {
  return (
    <div className="flex animate-pulse flex-col gap-8 p-4 sm:p-5 md:p-6">
      <div className="h-8 w-32 rounded bg-muted" />
      <section className="overflow-hidden rounded-lg border">
        <div className="h-14 border-b bg-muted/20" />
        <div className="space-y-4 p-4 md:p-5">
          <div className="h-9 w-64 rounded bg-muted" />
          <div className="overflow-hidden rounded-lg border">
            <div className="h-11 border-b bg-muted/50" />
            <div className="h-20 border-b bg-muted/30" />
            <div className="h-20 bg-muted/30" />
          </div>
        </div>
      </section>
      <div className="h-14 rounded-lg border bg-muted/20" />
    </div>
  );
}
