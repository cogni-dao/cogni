// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/layout/PageContainer`
 * Purpose: Mobile-first page wrapper with centered content, standard padding, and vertical stack.
 * Scope: Layout primitive for page-level content. Does not handle header/footer.
 * Invariants: Always centers content, applies consistent padding, stacks children vertically.
 * Side-effects: none
 * Notes: Mobile-first: px-4 py-6 on mobile, scales up on larger screens
 * Links: Tailwind spacing scale
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";

type MaxWidth = "sm" | "md" | "lg" | "xl" | "2xl" | "full";

const maxWidthClasses: Record<MaxWidth, string> = {
  sm: "max-w-sm", // 384px
  md: "max-w-md", // 448px
  lg: "max-w-lg", // 512px
  xl: "max-w-xl", // 576px
  "2xl": "max-w-2xl", // 672px
  full: "max-w-full",
};

interface PageContainerProps {
  children: React.ReactNode;
  maxWidth?: MaxWidth;
  className?: string;
}

export function PageContainer({
  children,
  maxWidth = "2xl",
  className,
}: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full space-y-6 px-4 py-6 sm:px-6",
        maxWidthClasses[maxWidth],
        className
      )}
    >
      {children}
    </div>
  );
}
