// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/code-hero-data`
 * Purpose: Data structure for homepage hero code block content.
 * Scope: Defines token arrays for hero code lines. Does not handle rendering or styling.
 * Invariants: Token IDs are unique within each line; spacing values match design tokens.
 * Side-effects: none
 * Notes: Feature-specific data that maps to the visual hero code appearance.
 * Links: src/components/kit/typography/CodeHero.tsx, src/features/home/components/HeroContent.tsx
 * @public
 */

import type { CodeToken } from "@/components";

export const heroLine1: CodeToken[] = [
  { id: "while", kind: "operator", text: "while", spacingRight: "xl" },
  { id: "together", kind: "variable", text: "together", spacingRight: "xs" },
  { id: "paren-open", kind: "parenthesis", text: "(", spacingRight: "xs" },
  // This will be replaced by HeroActionWords via tokenReplacements
  { id: "action-word", kind: "keyword", text: "build", spacingRight: "none" },
  { id: "paren-close", kind: "parenthesis", text: ")", spacingRight: "xs" },
  { id: "brace-open", kind: "delimiter", text: "{", spacingRight: "xs" },
];

export const heroLine2: CodeToken[] = [
  { id: "spacing", kind: "operator", text: "", spacingRight: "rainbow" },
  {
    id: "community",
    kind: "property",
    text: "community",
    spacingRight: "none",
  },
  { id: "increment", kind: "punctuation", text: "++;", spacingRight: "none" },
];

export const heroLine3: CodeToken[] = [
  { id: "brace-close", kind: "delimiter", text: "}", spacingRight: "none" },
];

// Actions for the HeroActionWords component
export const HERO_ACTIONS = [
  "build",
  "code",
  "own",
  "grow",
  "earn",
  "gov",
  "buy",
  "help",
  "share",
  "solve",
];
