// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui/data`
 * Purpose: Data display component styling factories.
 * Scope: Provides CVA factories for data presentation components. Does not handle data fetching or processing.
 * Invariants: All variants use design tokens; factories return valid Tailwind class strings; maintains elevation hierarchy.
 * Side-effects: none
 * Notes: Elevation and status variants follow design system hierarchy.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

import { cva, type VariantProps } from "class-variance-authority";

import type { SizeKey } from "@/styles/theme";

const avatarSizeVariants = {
  sm: "size-icon-sm",
  md: "size-icon-lg",
  lg: "size-icon-2xl",
  xl: "size-icon-4xl",
} satisfies Record<SizeKey, string>;

/**
 * Avatar component styling with consistent sizing variants
 */
export const avatar = cva(
  "relative flex shrink-0 overflow-hidden rounded-full",
  {
    variants: {
      size: avatarSizeVariants,
    },
    defaultVariants: {
      size: "md",
    },
  }
);

/**
 * Avatar image styling for proper aspect ratio and sizing
 */
export const avatarImage = cva("aspect-square size-full");

/**
 * Avatar fallback styling with background and centering
 */
export const avatarFallback = cva(
  "flex size-full items-center justify-center rounded-full bg-muted"
);

const cardVariants = {
  default: "",
  elevated: "shadow-lg",
  interactive: "cursor-pointer transition-shadow hover:shadow-md",
} as const;

/**
 * Card container styling with elevation variants
 */
export const card = cva(
  "rounded-lg border bg-card text-card-foreground shadow-sm",
  {
    variants: {
      variant: cardVariants,
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

/**
 * Card header styling for consistent spacing
 */
export const cardHeader = cva("flex flex-col space-y-4 p-8");

/**
 * Card content styling with proper padding
 */
export const cardContent = cva("p-8 pt-0");

/**
 * Card footer styling with border and spacing
 */
export const cardFooter = cva("flex items-center p-8 pt-0");

const badgeIntentVariants = {
  default:
    "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
  secondary:
    "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
  destructive:
    "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
  outline: "text-foreground",
} as const;

const badgeSizeVariants = {
  sm: "px-4 py-2 text-xs",
  md: "px-6 py-2 text-xs",
  lg: "px-8 py-4 text-sm",
  xl: "px-10 py-4 text-base",
} satisfies Record<SizeKey, string>;

/**
 * Badge component styling for status indicators
 */
export const badge = cva(
  "inline-flex items-center rounded-md border px-6 py-2 font-semibold text-xs transition-colors focus:outline-none focus:ring-[3px] focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      intent: badgeIntentVariants,
      size: badgeSizeVariants,
    } as const,
    defaultVariants: {
      intent: "default",
      size: "md",
    },
  }
);

const iconBoxSizeVariants = {
  sm: "h-icon-lg w-icon-lg",
  md: "h-icon-xl w-icon-xl",
  lg: "h-icon-2xl w-icon-2xl",
  xl: "h-icon-3xl w-icon-3xl",
} satisfies Record<SizeKey, string>;

const iconBoxColorVariants = {
  orange: "bg-warning",
  blue: "bg-primary",
  green: "bg-success",
  red: "bg-danger",
} as const;

/**
 * Icon box styling for feature icons
 */
export const iconBox = cva(
  "flex items-center justify-center rounded-md text-white",
  {
    variants: {
      size: iconBoxSizeVariants,
      color: iconBoxColorVariants,
    },
    defaultVariants: { size: "md", color: "blue" },
  }
);

/**
 * Stats display box for key metrics
 */
export const statsBox = cva("rounded-lg bg-muted p-6");

/**
 * Stats grid - responsive 2-column layout with top margin
 */
export const statsGrid = cva("mt-4 grid gap-2 lg:grid-cols-2");

const ledgerListGapVariants = {
  xs: "space-y-2",
  sm: "space-y-4",
} as const;

const ledgerListMtVariants = {
  none: "",
  lg: "mt-8",
} as const;

/**
 * Ledger list with vertical spacing and optional top margin
 */
export const ledgerList = cva("space-y-4", {
  variants: {
    gap: ledgerListGapVariants,
    mt: ledgerListMtVariants,
  },
  defaultVariants: { gap: "sm", mt: "none" },
});

/**
 * Ledger entry container for transaction history
 */
export const ledgerEntry = cva(
  "flex flex-col gap-1 rounded-md border border-border p-6"
);

/**
 * Ledger entry header row with space-between layout
 */
export const ledgerHeader = cva("flex items-center justify-between");

/**
 * Ledger metadata row with timestamp and balance info
 */
export const ledgerMeta = cva(
  "flex flex-wrap items-center gap-4 text-muted-foreground text-sm"
);

/**
 * Amount button grid for payment selection
 */
export const amountButtons = cva("flex flex-wrap gap-4");

// Export variant types for external use
export type BadgeIntent = VariantProps<typeof badge>["intent"];
