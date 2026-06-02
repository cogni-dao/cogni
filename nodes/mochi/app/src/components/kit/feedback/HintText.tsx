// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/feedback/HintText`
 * Purpose: Muted helper text with optional leading icon.
 * Scope: Display helper text, hints, disclaimers. Does not handle validation messages.
 * Invariants: Text is always muted (text-slate-600); icon alignment is top-aligned for multi-line text.
 * Side-effects: none
 * Notes: Mobile-first text sizing (text-sm)
 * Links: /dummy Credits page pattern
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";

interface HintTextProps {
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

export function HintText({ children, icon, className }: HintTextProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 text-muted-foreground text-sm",
        className
      )}
    >
      {icon && (
        <span className="mt-0.5 flex-shrink-0 text-muted-foreground">
          {icon}
        </span>
      )}
      <div>{children}</div>
    </div>
  );
}
