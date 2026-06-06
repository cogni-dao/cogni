// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/Badge`
 * Purpose: Badge component wrapper using project CVA styling instead of shadcn defaults.
 * Scope: Provides Badge functionality without className prop. Uses project design tokens. Does not handle content generation.
 * Invariants: No className forwarding; uses typed props only; integrates with design system.
 * Side-effects: none
 * Notes: Wraps shadcn Badge but replaces styling with project CVA factories from styles/ui/data.ts
 * Links: docs/spec/ui-implementation.md, src/styles/ui/data.ts
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import { Slot } from "@radix-ui/react-slot";
import type { ReactElement, ReactNode } from "react";
import { badge } from "@/styles/ui";

export interface BadgeProps {
  /** Badge visual intent/style */
  intent?: "default" | "secondary" | "destructive" | "outline";
  /** Badge size */
  size?: "sm" | "md" | "lg" | "xl";
  /** Badge content */
  children: ReactNode;
  /** Render as child element (for links/buttons) */
  asChild?: boolean;
  /** Optional layout-only overrides (e.g., margin). */
  className?: string;
}

export function Badge({
  intent = "default",
  size = "md",
  children,
  asChild = false,
  className,
}: BadgeProps): ReactElement {
  const COMPONENT = asChild ? Slot : "span";

  return (
    <COMPONENT className={cn(badge({ intent, size }), className)}>
      {children}
    </COMPONENT>
  );
}
