// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/sections/HomeHeroSection`
 * Purpose: Homepage-specific hero section with single-column layout (text → button → terminal).
 * Scope: Renders home hero layout structure. Does not handle content generation.
 * Invariants: Uses layout primitives; single-column responsive design.
 * Side-effects: none
 * Notes: Composes section, container, grid layout for homepage hero pattern.
 * Links: src/styles/ui/layout.ts
 * @public
 */

import type { ReactElement, ReactNode } from "react";

import {
  container,
  grid,
  heroButtons,
  heroText,
  heroVisual,
  section,
} from "@/components";

interface HomeHeroSectionProps {
  /**
   * Hero text content (code block and action words)
   */
  textContent: ReactNode;
  /**
   * Call-to-action button
   */
  buttonContent: ReactNode;
  /**
   * Terminal visual component
   */
  visualContent: ReactNode;
}

export function HomeHeroSection({
  textContent,
  buttonContent,
  visualContent,
}: HomeHeroSectionProps): ReactElement {
  return (
    <section className={section()}>
      <div className={container({ size: "lg", spacing: "xl" })}>
        <div className={grid({ cols: "12", gap: "md" })}>
          {/* Text content area */}
          <div className={heroText({ width: "fixed" })}>
            {textContent}

            {/* Button area */}
            <div className={heroButtons()}>{buttonContent}</div>
          </div>

          {/* Visual content area */}
          <div className={heroVisual()}>{visualContent}</div>
        </div>
      </div>
    </section>
  );
}
