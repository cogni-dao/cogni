// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/nodes/loading`
 * Purpose: Per-route Suspense fallback for `/nodes`. Mirrors the register form
 *   and owned-node grid so authenticated navigation has an immediate stable shell.
 * Scope: Server component, layout-preserving inside `(app)/layout.tsx`.
 * Side-effects: none
 * Links: ./page.tsx, src/components/kit/layout/CardGridSkeleton.tsx
 * @public
 */

import { PageContainer, SectionCard, Skeleton } from "@/components";
import { CardGridSkeleton } from "@/components/kit/layout/CardGridSkeleton";

export default function NodesLoading() {
  return (
    <PageContainer maxWidth="full" className="max-w-7xl">
      <SectionCard title="Register a node" className="mx-auto w-full max-w-3xl">
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-40" />
        </div>
      </SectionCard>

      <section className="space-y-4">
        <Skeleton className="h-9 w-40" />
        <CardGridSkeleton
          count={3}
          cols={{ base: 1, md: 2, lg: 3 }}
          cardHeight="h-48"
          gap="gap-5"
        />
      </section>
    </PageContainer>
  );
}
