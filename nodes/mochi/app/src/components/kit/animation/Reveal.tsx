// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/animation/Reveal`
 * Purpose: Reveal animation component wrapper with CVA styling API for progressive disclosure patterns.
 * Scope: Provides typed reveal variants wrapping CVA factories. Does not handle animation logic or timing.
 * Invariants: Forwards all props except className to div element; maintains ref forwarding; blocks className prop.
 * Side-effects: none
 * Notes: Uses CVA factory from \@/styles/ui - no literal classes allowed.
 * Links: src/styles/ui.ts, docs/spec/ui-implementation.md
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import type { VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { forwardRef } from "react";
import { reveal } from "@/styles/ui";

type DivNoClass = Omit<HTMLAttributes<HTMLDivElement>, "className">;

export interface RevealProps extends DivNoClass, VariantProps<typeof reveal> {
  /**
   * Optional className for layout/composition overrides. Animation styling remains CVA-driven.
   */
  className?: string;
}

export const Reveal = forwardRef<HTMLDivElement, RevealProps>(
  ({ state, duration, delay, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(reveal({ state, duration, delay }), className)}
      {...props}
    />
  )
);
Reveal.displayName = "Reveal";
