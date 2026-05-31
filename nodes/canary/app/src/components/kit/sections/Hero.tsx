// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/sections/Hero`
 * Purpose: Reusable hero section with two-column layout.
 * Scope: Renders text/visual columns. Does not handle content data.
 * Invariants: Responsive design; uses layout primitives.
 * Side-effects: none
 * Notes: Composes pageContainer, section, twoColumn.
 * Links: src/styles/ui/layout.ts
 * @public
 */

import type { ReactNode } from "react";

import { pageContainer, section, twoColumn } from "@/styles/ui";

interface HeroProps {
  textSide: ReactNode;
  visualSide: ReactNode;
  reverse?: boolean;
  maxWidth?: "md" | "lg" | "xl";
}

export function Hero({
  textSide,
  visualSide,
  reverse = false,
  maxWidth = "xl",
}: HeroProps): ReactNode {
  return (
    <section className={section()}>
      <div className={pageContainer({ maxWidth })}>
        <div className={twoColumn({ reverse })}>
          <div>{textSide}</div>
          <div>{visualSide}</div>
        </div>
      </div>
    </section>
  );
}
