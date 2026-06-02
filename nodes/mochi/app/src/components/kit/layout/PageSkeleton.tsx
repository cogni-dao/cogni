// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/layout/PageSkeleton`
 * Purpose: Standard Suspense fallback for server page shells wrapping client views.
 * Scope: Layout-preserving skeleton inside PageContainer. Does not fetch data or use client hooks.
 * Invariants: Matches PageContainer padding/spacing so hydration produces no layout shift.
 * Side-effects: none
 * Links: src/components/kit/layout/PageContainer.tsx
 * @public
 */

import { Skeleton } from "@cogni/node-ui-kit/shadcn/skeleton";
import { PageContainer } from "./PageContainer";

type MaxWidth = "sm" | "md" | "lg" | "xl" | "2xl" | "full";

interface PageSkeletonProps {
  maxWidth?: MaxWidth;
}

export function PageSkeleton({ maxWidth = "2xl" }: PageSkeletonProps) {
  return (
    <PageContainer maxWidth={maxWidth}>
      <Skeleton className="h-8 w-40" />
      <div className="border-border border-b" />
      <div className="space-y-4">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-5/6" />
      </div>
    </PageContainer>
  );
}
