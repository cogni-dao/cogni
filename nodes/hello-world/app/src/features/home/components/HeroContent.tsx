// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/HeroContent`
 * Purpose: Homepage hero content composition using code primitives and CTAs.
 * Scope: Feature component that composes hero text content. Does not handle layout container.
 * Invariants: Uses kit components only; no direct styling; maintains visual hierarchy.
 * Side-effects: none
 * Notes: Composes CodeHeroLine, HeroActionWords, and Button for homepage hero section.
 * Links: src/features/home/code-hero-data.ts, src/components/kit/typography/CodeHero.tsx
 * @public
 */

import type { ReactElement } from "react";

import {
  CodeTokenLine,
  HeroActionContainer,
  HeroActionWords,
  HeroCodeBlock,
} from "@/components";

import {
  HERO_ACTIONS,
  heroLine1,
  heroLine2,
  heroLine3,
} from "../code-hero-data";

export function HeroContent(): ReactElement {
  return (
    <HeroCodeBlock>
      {/* Line 1: while together(action) { with inline animated action word */}
      <CodeTokenLine
        tokens={heroLine1}
        tokenReplacements={{
          "action-word": (
            <HeroActionContainer>
              <HeroActionWords actions={HERO_ACTIONS} kind="keyword" />
            </HeroActionContainer>
          ),
        }}
      />

      {/* Line 2: community++; */}
      <HeroCodeBlock spacing="normal">
        <CodeTokenLine tokens={heroLine2} tone="subdued" level="p" />
      </HeroCodeBlock>

      {/* Line 3: } */}
      <HeroCodeBlock spacing="normal">
        <CodeTokenLine tokens={heroLine3} tone="subdued" level="p" />
      </HeroCodeBlock>
    </HeroCodeBlock>
  );
}
