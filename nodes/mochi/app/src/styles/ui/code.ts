// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui/code`
 * Purpose: Code syntax highlighting and spacing styling factories.
 * Scope: Provides CVA factories for code token styling and layout. Does not handle component logic.
 * Invariants: All variants use design tokens; token kinds map to syntax-* palette; maintains accessibility.
 * Side-effects: none
 * Notes: Extracted from typography.ts for better organization of code-specific styling.
 * Links: src/components/kit/typography/CodeHero.tsx, src/styles/theme.ts
 * @public
 */

import { cva } from "class-variance-authority";

const codeTokenKindVariants = {
  keyword: "!text-syntax-keyword",
  operator: "!text-syntax-operator",
  variable: "!text-syntax-string",
  punctuation: "!text-muted-foreground",
  parenthesis: "!text-syntax-punctuation",
  property: "!text-syntax-property",
  delimiter: "!text-syntax-delimiter",
  // Aliases for hero code components
  // Same as variable
  identifier: "!text-syntax-string",
  // Same as property
  accent: "!text-syntax-property",
} as const;

const codeTokenSpacingRightVariants = {
  none: "",
  xs: "pr-[var(--hero-spacing-xs)]",
  xl: "pr-[var(--hero-spacing-xl)]",
  rainbow: "pr-[var(--hero-spacing-rainbow)]",
} as const;

/**
 * Code token styling with syntax highlighting and optional right spacing
 */
export const codeToken = cva("", {
  variants: {
    kind: codeTokenKindVariants,
    spacingRight: codeTokenSpacingRightVariants,
  },
  defaultVariants: {
    kind: "keyword",
    spacingRight: "none",
  },
});

const heroCodeBlockSpacingVariants = {
  none: "",
  normal: "pt-[var(--hero-spacing-xl)]",
} as const;

/**
 * Hero code block wrapper with consistent spacing
 */
export const heroCodeBlock = cva("", {
  variants: {
    spacing: heroCodeBlockSpacingVariants,
  },
  defaultVariants: {
    spacing: "none",
  },
});

/**
 * Action words container with fixed width for hero animations
 */
export const heroActionContainer = cva(
  "inline-block w-[var(--width-action-words)]"
);
