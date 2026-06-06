// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/layout/CardGridSkeleton`
 * Purpose: Responsive grid of card-shaped skeletons. Used for routes
 *   dominated by stacked or grid-arranged cards (dashboard sections,
 *   credits 2-col, activity charts row, marketing card rows).
 * Scope: Composable layout primitive. Does not include outer container.
 * Invariants:
 *   - Cards render with rounded-lg + the card height passed in.
 *   - Responsive cols: `cols.base` on mobile, `cols.md` on md+, `cols.lg`
 *     on lg+. Stacks correctly down to single column on small screens.
 * Side-effects: none
 * Links: src/components/vendor/shadcn/skeleton.tsx, src/components/kit/layout/Card.tsx
 * @public
 */

import { Skeleton } from "@cogni/node-ui-kit/shadcn/skeleton";

type ColCount = 1 | 2 | 3 | 4;

const colClass: Record<ColCount, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
};

const mdColClass: Record<ColCount, string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
};

const lgColClass: Record<ColCount, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

interface CardGridSkeletonProps {
  /** Number of cards. Default: `3`. */
  readonly count?: number;
  /** Cols at base/md/lg breakpoints. Defaults: `{ base: 1, md: 3 }`. */
  readonly cols?: {
    readonly base?: ColCount;
    readonly md?: ColCount;
    readonly lg?: ColCount;
  };
  /** Tailwind height class for each card. Default: `h-32`. */
  readonly cardHeight?: string;
  /** Tailwind gap class. Default: `gap-4`. */
  readonly gap?: string;
}

export function CardGridSkeleton({
  count = 3,
  cols = { base: 1, md: 3 },
  cardHeight = "h-32",
  gap = "gap-4",
}: CardGridSkeletonProps) {
  const baseCol = cols.base ?? 1;
  const mdCol = cols.md;
  const lgCol = cols.lg;
  const classes = [
    "grid",
    gap,
    colClass[baseCol],
    mdCol ? mdColClass[mdCol] : "",
    lgCol ? lgColClass[lgCol] : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cards are static placeholders, not data
        <Skeleton key={i} className={`${cardHeight} w-full rounded-lg`} />
      ))}
    </div>
  );
}
