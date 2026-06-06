// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui/typography`
 * Purpose: Typography component styling factories.
 * Scope: Provides CVA factories for text presentation components. Does not handle content processing.
 * Invariants: All variants use design tokens; factories return valid Tailwind class strings; maintains typographic hierarchy.
 * Side-effects: none
 * Notes: Typography scale follows design system hierarchy with responsive sizing.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

import { cva, type VariantProps } from "class-variance-authority";

import type {
  BasicSpacingKey,
  FontFamilyKey,
  FontWeightKey,
  SizeKey,
} from "@/styles/theme";

const headingLevelVariants = {
  h1: "text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl",
  h2: "text-3xl font-bold sm:text-4xl",
  h3: "text-lg font-medium",
  h4: "text-base font-medium",
} as const;

const headingToneVariants = {
  default: "text-foreground",
  subdued: "text-muted-foreground",
  invert: "text-background",
} as const;

const headingFamilyVariants = {
  sans: "font-sans",
  mono: "font-mono",
  display: "font-display",
} satisfies Record<FontFamilyKey, string>;

const headingWeightVariants = {
  regular: "font-normal",
  medium: "font-medium",
  bold: "font-bold",
} satisfies Record<FontWeightKey, string>;

/**
 * Heading typography with level scale and tone variants
 */
export const heading = cva("", {
  variants: {
    level: headingLevelVariants,
    tone: headingToneVariants,
    family: headingFamilyVariants,
    weight: headingWeightVariants,
  },
  defaultVariants: {
    level: "h2",
    tone: "default",
    family: "sans",
    weight: "bold",
  },
});

const paragraphSizeVariants = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
  xl: "text-xl",
} satisfies Record<SizeKey, string>;

const paragraphToneVariants = {
  default: "text-foreground",
  subdued: "text-muted-foreground",
  invert: "text-background",
} as const;

const paragraphFamilyVariants = {
  sans: "font-sans",
  mono: "font-mono",
  display: "font-display",
} satisfies Record<FontFamilyKey, string>;

const paragraphSpacingVariants = {
  none: "",
  xs: "mt-3",
  sm: "mt-7",
  md: "mt-7",
  lg: "mt-11",
  xl: "mt-14",
} satisfies Record<BasicSpacingKey, string>;

/**
 * Paragraph styling with size and tone variants
 */
export const paragraph = cva("", {
  variants: {
    size: paragraphSizeVariants,
    tone: paragraphToneVariants,
    family: paragraphFamilyVariants,
    spacing: paragraphSpacingVariants,
  },
  defaultVariants: {
    size: "md",
    tone: "subdued",
    family: "sans",
    spacing: "md",
  },
});

const proseSizeVariants = {
  sm: "prose-sm",
  md: "prose-base",
  lg: "prose-lg",
  xl: "prose-xl",
} satisfies Record<SizeKey, string>;

const proseToneVariants = {
  default: "",
  invert: "prose-invert",
} as const;

/**
 * Prose styling for rich text content with size and tone variants
 */
export const prose = cva("prose", {
  variants: {
    size: proseSizeVariants,
    tone: proseToneVariants,
  },
  defaultVariants: {
    size: "md",
    tone: "default",
  },
});

const promptToneVariants = {
  default: "text-foreground",
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
} as const;

const promptFamilyVariants = {
  sans: "font-sans",
  mono: "font-mono",
  display: "font-display",
} satisfies Record<FontFamilyKey, string>;

/**
 * Terminal prompt styling with semantic tone variants
 */
export const prompt = cva("", {
  variants: {
    tone: promptToneVariants,
    family: promptFamilyVariants,
  },
  defaultVariants: {
    tone: "default",
    family: "mono",
  },
});

/**
 * Accent text styling for highlighted spans
 */
export const textAccent = cva("block text-warning");

const brandTextSizeVariants = {
  sm: "text-base font-semibold",
  md: "text-lg font-semibold",
  lg: "text-xl font-semibold",
  xl: "text-2xl font-semibold",
} satisfies Record<SizeKey, string>;

const brandTextToneVariants = {
  default: "text-foreground",
  subdued: "text-muted-foreground",
  invert: "text-background",
  gradient:
    "bg-gradient-to-r from-syntax-operator via-syntax-property to-syntax-delimiter bg-clip-text text-transparent",
} as const;

/**
 * Brand text styling for logo and branding elements
 */
export const brandText = cva("tracking-tight", {
  variants: {
    size: brandTextSizeVariants,
    tone: brandTextToneVariants,
  } as const,
  defaultVariants: {
    size: "lg",
    tone: "default",
  },
});

// Export variant types for external use
export type HeadingLevel = VariantProps<typeof heading>["level"];
export type BrandTextSize = VariantProps<typeof brandText>["size"];
export type BrandTextTone = VariantProps<typeof brandText>["tone"];
