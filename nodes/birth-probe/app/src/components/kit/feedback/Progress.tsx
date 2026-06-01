// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/feedback/Progress`
 * Purpose: Kit wrapper for shadcn Progress component for transaction confirmation tracking.
 * Scope: Re-exports shadcn Progress with semantic token styling. Does not contain business logic.
 * Invariants: Forwards ref; accepts value 0-100; uses semantic tokens for colors.
 * Side-effects: none
 * Notes: Wraps Radix UI Progress primitive via shadcn for consistent kit API.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";

export interface ProgressProps
  extends ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {}

export const Progress = forwardRef<
  ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
      className
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-primary transition-all"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;
