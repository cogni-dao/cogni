// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/inputs/Button`
 * Purpose: Button component wrapper using CVA styling with Radix Slot composition for interactive actions.
 * Scope: Provides Button component with variant props. Does not handle form submission or navigation routing.
 * Invariants: Forwards ref; accepts aria-* and data-* unchanged; always renders valid button or slot.
 * Side-effects: none
 * Notes: Uses CVA factory from \@/styles/ui - no literal classes allowed; supports asChild pattern.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import { Slot } from "@radix-ui/react-slot";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cloneElement, forwardRef, isValidElement } from "react";
import { button, icon } from "@/styles/ui";

type ButtonBaseProps = ComponentProps<"button">;

export interface ButtonProps
  extends Omit<ButtonBaseProps, "className">,
    VariantProps<typeof button> {
  /**
   * Optional className for layout/composition overrides only (flex/gap/margins).
   * Colors/typography remain controlled by CVA variants.
   */
  className?: string;
  asChild?: boolean;
  /**
   * Right icon component (Lucide icon)
   */
  rightIcon?: ReactNode;
  /**
   * Icon size variant
   */
  iconSize?: "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant,
      size,
      asChild = false,
      rightIcon,
      iconSize = "md",
      children,
      className,
      ...props
    },
    ref
  ) => {
    const iconElement = rightIcon ? (
      <span className={icon({ size: iconSize })} aria-hidden="true">
        {rightIcon}
      </span>
    ) : null;

    if (asChild) {
      if (!isValidElement(children)) {
        throw new Error(
          "Button with `asChild` expects a single React element child."
        );
      }

      const childElement = children as ReactElement<{ children?: ReactNode }>;

      const childWithIcon =
        iconElement && childElement.props
          ? cloneElement(childElement, {
              ...childElement.props,
              children: (
                <>
                  {childElement.props.children}
                  {iconElement}
                </>
              ),
            })
          : childElement;

      return (
        <Slot
          data-slot="button"
          className={cn(button({ variant, size }), className)}
          ref={ref}
          {...props}
        >
          {childWithIcon}
        </Slot>
      );
    }

    return (
      <button
        data-slot="button"
        className={cn(button({ variant, size }), className)}
        ref={ref}
        {...props}
      >
        {children}
        {iconElement}
      </button>
    );
  }
);

Button.displayName = "Button";
