// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/typography/CodeHero`
 * Purpose: Kit components and types for rendering syntax-highlighted code in hero sections.
 * Scope: Provides reusable code hero primitives. Does not handle feature-specific data.
 * Invariants: Uses CVA factories from styles/ui; no className props; maintains type safety.
 * Side-effects: none
 * Notes: Combines types and components for data-driven hero code composition.
 * Links: src/styles/ui/code.ts, src/features/home/code-hero-data.ts
 * @public
 */

import type { ReactElement, ReactNode } from "react";
import { createElement } from "react";

import {
  codeToken,
  heading,
  heroActionContainer,
  heroCodeBlock,
} from "@/styles/ui";

// Types
export type CodeTokenKind =
  | "keyword"
  | "identifier"
  | "operator"
  | "punctuation"
  | "accent"
  | "parenthesis"
  | "property"
  | "delimiter"
  | "variable";

export type CodeTokenSpacing = "none" | "xs" | "xl" | "rainbow";

export interface CodeToken {
  id: string;
  kind: CodeTokenKind;
  text: string;
  spacingRight?: CodeTokenSpacing;
}

// Components
interface CodeTokenLineProps {
  tokens: CodeToken[];
  /**
   * Typography tone for the entire line.
   * Default uses standard foreground color.
   */
  tone?: "default" | "subdued";
  /**
   * Heading level for semantic HTML.
   * Default h1 for main hero content.
   */
  level?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p";
  /**
   * Replace specific tokens with custom content.
   * For token id X, render the provided content instead of token.text.
   */
  tokenReplacements?: Record<string, ReactNode>;
}

export function CodeTokenLine({
  tokens,
  tone = "default",
  level = "h1",
  tokenReplacements,
}: CodeTokenLineProps): ReactElement {
  return createElement(
    level,
    {
      className: heading({
        level: level === "p" ? "h1" : (level as "h1" | "h2" | "h3" | "h4"),
        tone,
        family: "mono",
        weight: "regular",
      }),
    },
    tokens.map((token) => {
      const replacement = tokenReplacements?.[token.id];
      return (
        <span
          key={token.id}
          className={codeToken({
            kind: token.kind,
            spacingRight: token.spacingRight,
          })}
        >
          {replacement ?? token.text}
        </span>
      );
    })
  );
}

interface HeroCodeBlockProps {
  children: ReactNode;
  /**
   * Additional spacing between lines.
   */
  spacing?: "none" | "normal";
}

export function HeroCodeBlock({
  children,
  spacing = "none",
}: HeroCodeBlockProps): ReactElement {
  return <div className={heroCodeBlock({ spacing })}>{children}</div>;
}

interface HeroActionContainerProps {
  children: ReactNode;
}

export function HeroActionContainer({
  children,
}: HeroActionContainerProps): ReactElement {
  return <div className={heroActionContainer()}>{children}</div>;
}
