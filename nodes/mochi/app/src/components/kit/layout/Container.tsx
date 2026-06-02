// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/layout/Container`
 * Purpose: Container component wrapper with CVA sizing and spacing variants.
 * Scope: Provides typed container variants using CVA factories. Does not handle responsive logic beyond CSS.
 * Invariants: Forwards props to div element; className overrides are layout-only; maintains ref forwarding.
 * Side-effects: none
 * Notes: Uses CVA factory from \@/styles/ui - no literal classes allowed.
 * Links: src/styles/ui.ts, docs/spec/ui-implementation.md
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { container } from "@/styles/ui";

type DivNoClass = Omit<React.HTMLAttributes<HTMLDivElement>, "className">;

export interface ContainerProps
  extends DivNoClass,
    VariantProps<typeof container> {
  /**
   * Optional className for layout/composition overrides. Core styling remains CVA-driven.
   */
  className?: string;
}

export const Container = React.forwardRef<HTMLDivElement, ContainerProps>(
  ({ size, spacing, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(container({ size, spacing }), className)}
      {...props}
    />
  )
);
Container.displayName = "Container";
