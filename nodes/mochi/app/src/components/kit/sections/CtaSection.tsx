// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/sections/CtaSection`
 * Purpose: Kit component for call-to-action sections with responsive two-column layout.
 * Scope: Provides styled CTA section container. Does not handle content generation.
 * Invariants: Uses layout primitives; responsive design; consistent spacing.
 * Side-effects: none
 * Notes: Encapsulates section/container/grid styling for CTA patterns.
 * Links: src/styles/ui/layout.ts
 * @public
 */

import type { ReactElement, ReactNode } from "react";

import {
  container,
  flex,
  grid,
  heading,
  paragraph,
  section,
} from "@/styles/ui";

interface CtaSectionProps {
  /**
   * Main heading content
   */
  heading: ReactNode;
  /**
   * Supporting paragraph content
   */
  paragraph: ReactNode;
  /**
   * Call-to-action button or link
   */
  action: ReactNode;
  /**
   * Background surface variant
   */
  surface?: "default" | "muted";
}

export function CtaSection({
  heading: headingContent,
  paragraph: paragraphContent,
  action,
  surface = "muted",
}: CtaSectionProps): ReactElement {
  return (
    <section className={section({ surface })}>
      <div className={container({ size: "lg", spacing: "lg" })}>
        <div className={grid({ cols: "2", align: "center", gap: "md" })}>
          <div>
            <h2 className={heading({ level: "h2", tone: "default" })}>
              {headingContent}
            </h2>
            <p className={paragraph({ size: "lg", spacing: "md" })}>
              {paragraphContent}
            </p>
          </div>
          <div className={flex({ justify: "center", spacing: "lg" })}>
            {action}
          </div>
        </div>
      </div>
    </section>
  );
}
