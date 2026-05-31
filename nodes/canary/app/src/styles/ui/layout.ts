// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui/layout`
 * Purpose: Layout component styling factories.
 * Scope: Provides CVA factories for layout and spacing components. Does not handle responsive breakpoint logic.
 * Invariants: All variants use design tokens; factories return valid Tailwind class strings; maintains responsive patterns.
 * Side-effects: none
 * Notes: Responsive variants follow mobile-first approach with consistent spacing scale.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

import { cva, type VariantProps } from "class-variance-authority";

import type { BasicSpacingKey, SizeKey } from "@/styles/theme";

// Common variant patterns (DRY)
const flexAlignVariants = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
} as const;

const flexJustifyVariants = {
  start: "justify-start",
  center: "justify-center",
  between: "justify-between",
  end: "justify-end",
} as const;

const containerAllSizeVariants = {
  sm: "max-w-container-md",
  md: "max-w-container-xl",
  lg: "max-w-container-3xl",
  xl: "max-w-container-screen",
  full: "max-w-full",
} as const;

const spacingVariants = {
  none: "",
  xs: "py-4",
  sm: "py-10",
  md: "py-16",
  lg: "py-20",
  xl: "py-24",
} satisfies Record<BasicSpacingKey, string>;

const gapVariants = {
  none: "",
  xs: "gap-2",
  sm: "gap-10 lg:gap-8",
  md: "gap-8 lg:gap-10",
  lg: "gap-10 lg:gap-icon-xl",
  xl: "gap-icon-xl lg:gap-icon-2xl",
} satisfies Record<BasicSpacingKey, string>;

const paddingVariants = {
  none: "",
  xs: "p-2",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
  xl: "p-10",
} satisfies Record<BasicSpacingKey, string>;

/**
 * Page shell styling for full-page body wrapper
 */
export const pageShell = cva(
  "min-h-dvh bg-background text-foreground antialiased"
);

const pageContainerMaxWidthVariants = {
  sm: "max-w-container-sm",
  md: "max-w-container-lg",
  lg: "max-w-container-2xl",
  xl: "max-w-container-3xl",
} satisfies Record<SizeKey, string>;

/**
 * Page container styling for centered content with responsive max-width
 */
export const pageContainer = cva("mx-auto w-full px-6 sm:px-9 lg:px-10", {
  variants: {
    maxWidth: pageContainerMaxWidthVariants,
  },
  defaultVariants: { maxWidth: "lg" },
});

const twoColumnReverseVariants = {
  false: "",
  true: "lg:grid-flow-col-dense",
} as const;

/**
 * Two-column responsive layout with optional reverse flow
 */
export const twoColumn = cva("grid gap-10 lg:grid-cols-2 lg:items-center", {
  variants: {
    reverse: twoColumnReverseVariants,
  },
  defaultVariants: { reverse: false },
});

/**
 * Container styling for responsive layout wrappers with width and padding variants
 */
export const container = cva("mx-auto px-6 sm:px-8 lg:px-10", {
  variants: {
    size: containerAllSizeVariants,
    spacing: spacingVariants,
  },
  defaultVariants: {
    size: "lg",
    spacing: "none",
  },
});

const sectionSurfaceVariants = {
  default: "",
  card: "bg-card",
  muted: "bg-muted",
  inverse: "bg-primary text-primary-foreground",
} as const;

/**
 * Section styling for page sections with surface variants for theming
 */
export const section = cva("w-full", {
  variants: {
    surface: sectionSurfaceVariants,
  },
  defaultVariants: {
    surface: "default",
  },
});

const gridColsVariants = {
  "1": "",
  "2": "grid lg:grid-cols-2",
  "3": "grid lg:grid-cols-3",
  "4": "grid lg:grid-cols-4",
  "12": "grid lg:grid-cols-12",
} as const;

const gridAlignVariants = {
  default: "",
  center: "items-center",
} as const;

/**
 * Grid layout styling with responsive column and gap variants
 */
export const grid = cva("", {
  variants: {
    cols: gridColsVariants,
    gap: gapVariants,
    align: gridAlignVariants,
  },
  defaultVariants: {
    gap: "md",
  },
});

// Row-specific gap variants (smaller scale than grid)
const rowGapVariants = {
  none: "",
  xs: "gap-4",
  sm: "gap-3",
  md: "gap-6",
  lg: "gap-8",
  xl: "gap-10",
} satisfies Record<BasicSpacingKey, string>;

/**
 * Row layout styling for flex containers with alignment and spacing variants
 */
export const row = cva("flex", {
  variants: {
    align: flexAlignVariants,
    justify: flexJustifyVariants,
    gap: rowGapVariants,
  },
  defaultVariants: {
    align: "center",
    justify: "start",
    gap: "none",
  },
});

/**
 * Padding utility styling for consistent spacing variants
 */
export const pad = cva("", {
  variants: {
    p: paddingVariants,
  },
  defaultVariants: {
    p: "none",
  },
});

const flexDirectionVariants = {
  row: "flex-row",
  col: "flex-col",
} as const;

const flexWrapVariants = {
  wrap: "flex-wrap",
  nowrap: "flex-nowrap",
} as const;

// Flex-specific spacing (margin-top instead of padding)
const flexSpacingVariants = {
  none: "",
  xs: "mt-4",
  sm: "mt-6",
  md: "mt-9",
  lg: "mt-10",
  xl: "mt-12",
} satisfies Record<BasicSpacingKey, string>;

/**
 * Flex container styling with alignment and spacing variants
 */
export const flex = cva("flex", {
  variants: {
    direction: flexDirectionVariants,
    align: flexAlignVariants,
    justify: flexJustifyVariants,
    wrap: flexWrapVariants,
    spacing: flexSpacingVariants,
  },
  defaultVariants: {
    direction: "row",
    align: "start",
    justify: "start",
    wrap: "nowrap",
    spacing: "none",
  },
});

// Header-specific padding variants (y-axis only)
const headerPaddingVariants = {
  none: "",
  xs: "py-1",
  sm: "py-4",
  md: "py-6",
  lg: "py-9",
  xl: "py-10",
} satisfies Record<BasicSpacingKey, string>;

/**
 * Header styling for site header with border, background, and padding
 */
export const header = cva("border-border border-b bg-background", {
  variants: {
    pad: headerPaddingVariants,
  },
  defaultVariants: {
    pad: "md",
  },
});

const heroTextWidthVariants = {
  auto: "",
  fixed: "[&>h1]:min-w-measure",
} as const;

/**
 * Hero text wrapper with responsive alignment
 */
export const heroText = cva(
  "sm:text-center md:mx-auto md:max-w-container-lg lg:col-span-12 lg:mb-10 lg:text-left",
  {
    variants: {
      width: heroTextWidthVariants,
    },
    defaultVariants: { width: "auto" },
  }
);

/**
 * Hero button container - MOBILE FIX: mx-0 baseline
 */
export const heroButtons = cva("sm:-mx-20 md:-mx-24 mx-0 mt-10 text-center");

/**
 * Hero visual container
 */
export const heroVisual = cva(
  "relative mt-7 sm:mx-auto lg:col-span-12 lg:mx-auto lg:mt-0 lg:max-w-none"
);

// Export variant types for external use
export type ContainerSize = VariantProps<typeof container>["size"];
