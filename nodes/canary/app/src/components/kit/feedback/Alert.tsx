// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/feedback/Alert`
 * Purpose: Kit wrapper for shadcn Alert with extended variants for payment flow feedback.
 * Scope: Re-exports shadcn Alert, AlertTitle, AlertDescription with added success variant. Does not contain business logic.
 * Invariants: Forwards ref; accepts aria-* and data-* unchanged; uses semantic tokens only.
 * Side-effects: none
 * Notes: Extends shadcn default/destructive with success variant for positive feedback states.
 * Links: docs/spec/ui-implementation.md, docs/spec/payments-design.md
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { forwardRef } from "react";

const alertVariants = cva(
  "relative w-full rounded-lg border px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--text-sm)] [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:top-4 [&>svg]:left-4 [&>svg]:text-foreground [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default: "border-border bg-background text-foreground",
        destructive:
          "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
        success:
          "border-success/50 bg-success/10 text-success dark:border-success dark:bg-success/10 [&>svg]:text-success",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface AlertProps
  extends ComponentProps<"div">,
    VariantProps<typeof alertVariants> {}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
);
Alert.displayName = "Alert";

export const AlertTitle = forwardRef<
  HTMLParagraphElement,
  ComponentProps<"h5">
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 font-medium leading-none tracking-tight", className)}
    {...props}
  />
));
AlertTitle.displayName = "AlertTitle";

export const AlertDescription = forwardRef<
  HTMLParagraphElement,
  ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-[var(--text-sm)] [&_p]:leading-relaxed", className)}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";
