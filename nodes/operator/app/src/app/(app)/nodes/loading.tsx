// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Layout-preserving route fallback for the authenticated node list. */

import { PageContainer, Skeleton } from "@/components";
import { CardGridSkeleton } from "@/components/kit/layout/CardGridSkeleton";

export default function NodesLoading() {
  return (
    <PageContainer maxWidth="full" className="max-w-7xl animate-pulse">
      <section className="mx-auto w-full max-w-3xl space-y-4 rounded-lg border p-6">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-28" />
      </section>

      <section className="space-y-4">
        <Skeleton className="h-9 w-40" />
        <CardGridSkeleton
          count={3}
          cols={{ base: 1, md: 2, lg: 3 }}
          cardHeight="h-48"
        />
      </section>
    </PageContainer>
  );
}
