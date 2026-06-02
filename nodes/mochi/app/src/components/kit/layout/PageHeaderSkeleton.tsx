// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/layout/PageHeaderSkeleton`
 * Purpose: Reusable page-title + optional subtitle skeleton block. Used at
 *   the top of every per-route `loading.tsx` so the heading bar paints in
 *   the same place as the rendered page's `<h1>`.
 * Scope: Composable layout primitive. Does not include outer container —
 *   compose inside `PageContainer` or a route-specific shell.
 * Invariants: Heading height matches the codebase's `text-2xl` / `text-xl`
 *   tracking-tight title. Subtitle paragraph height matches `text-sm`.
 * Side-effects: none
 * Links: src/components/vendor/shadcn/skeleton.tsx, src/components/kit/layout/PageSkeleton.tsx
 * @public
 */

import { Skeleton } from "@cogni/node-ui-kit/shadcn/skeleton";

interface PageHeaderSkeletonProps {
  /** Width of the title bar in tailwind class form. Default: `w-44`. */
  readonly titleWidth?: string;
  /** Render a subtitle paragraph line below the title. */
  readonly withSubtitle?: boolean;
  /** Width of the subtitle in tailwind class form. Default: `w-96`. */
  readonly subtitleWidth?: string;
}

export function PageHeaderSkeleton({
  titleWidth = "w-44",
  withSubtitle = false,
  subtitleWidth = "w-96",
}: PageHeaderSkeletonProps) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className={`h-8 ${titleWidth}`} />
      {withSubtitle ? (
        <Skeleton className={`h-4 ${subtitleWidth} max-w-full`} />
      ) : null}
    </div>
  );
}
