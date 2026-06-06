// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui/inputs`
 * Purpose: Input component styling factories (buttons, forms, controls).
 * Scope: Provides CVA factories for interactive input components. Does not handle component logic.
 * Invariants: All variants use design tokens; factories return valid Tailwind class strings.
 * Side-effects: none
 * Notes: Based on reference repo styling with modern focus states.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

import { cva, type VariantProps } from "class-variance-authority";

import type { SizeKey } from "@/styles/theme";

const buttonBase =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const buttonToneVariants = {
  default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
  accent:
    "bg-[linear-gradient(135deg,hsl(var(--accent-from)),hsl(var(--accent-to)))] text-white shadow transition-shadow hover:shadow-[0_0_20px_hsl(var(--accent-glow)/0.25)] focus-visible:shadow-[0_0_20px_hsl(var(--accent-glow)/0.25)]",
  destructive:
    "bg-destructive text-destructive-foreground shadow hover:bg-destructive/90",
  outline:
    "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
  secondary:
    "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  link: "text-primary underline-offset-4 hover:underline",
} as const;

const buttonSizeVariants = {
  sm: "h-9 px-3",
  md: "h-10 px-4 py-2",
  lg: "h-11 px-8",
  xl: "h-12 px-8",
} satisfies Record<SizeKey, string>;

const buttonIconVariants = {
  true: "h-10 w-10",
  false: "",
} as const;

/**
 * Button component styling matching reference repo with modern focus states
 */
export const button = cva(buttonBase, {
  variants: {
    variant: buttonToneVariants,
    size: buttonSizeVariants,
    icon: buttonIconVariants,
  },
  defaultVariants: { variant: "default", size: "md", icon: false },
});

const modeToggleBase =
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const modeToggleToneVariants = {
  ghost: "hover:bg-accent hover:text-accent-foreground",
  outline:
    "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
} as const;

const modeToggleSizeVariants = {
  sm: "h-9 w-9",
  md: "h-10 w-10",
  lg: "h-11 w-11",
  xl: "h-12 w-12",
} satisfies Record<SizeKey, string>;

/**
 * Mode toggle button styling for theme switching with icon-only design
 */
export const modeToggle = cva(modeToggleBase, {
  variants: {
    variant: modeToggleToneVariants,
    size: modeToggleSizeVariants,
  },
  defaultVariants: {
    variant: "ghost",
    size: "md",
  },
});

/**
 * Input component styling for text-based inputs
 */
export const input = cva(
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:font-medium file:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
);

// Export variant types for external use
export type ButtonVariant = VariantProps<typeof button>["variant"];
export type ButtonSize = VariantProps<typeof button>["size"];
export type ModeToggleVariant = VariantProps<typeof modeToggle>["variant"];
export type ModeToggleSize = VariantProps<typeof modeToggle>["size"];
