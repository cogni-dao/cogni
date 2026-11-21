// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/Avatar`
 * Purpose: Avatar component wrapper with CVA styling API and design token enforcement.
 * Scope: Provides typed Avatar variants wrapping shadcn/ui primitives. Does not modify underlying UI components.
 * Invariants: Forwards all props to ui components; maintains ref forwarding; provides size variants via CVA.
 * Side-effects: none
 * Notes: Wraps vendor/ui-primitives/shadcn/avatar to keep shadcn components pure and updatable.
 * Links: src/styles/ui.ts, https://node-template.cognidao.org/knowledge/frontend-development
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { avatar, avatarFallback, avatarImage } from "@/styles/ui";

export interface AvatarProps
  extends Omit<
      React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>,
      "className"
    >,
    VariantProps<typeof avatar> {
  /**
   * Optional className for layout adjustments (e.g., margin). Core styling stays controlled by CVA.
   */
  className?: string;
}

export const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  AvatarProps
>(({ size, className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(avatar({ size }), className)}
    {...props}
  />
));
Avatar.displayName = "Avatar";

export const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  Omit<
    React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>,
    "className"
  > & {
    className?: string;
  }
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn(avatarImage(), className)}
    {...props}
  />
));
AvatarImage.displayName = "AvatarImage";

export const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  Omit<
    React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>,
    "className"
  > & {
    className?: string;
  }
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(avatarFallback(), className)}
    {...props}
  />
));
AvatarFallback.displayName = "AvatarFallback";

/** A custom hex fill needs its own foreground; the primary fallback keeps its token pair. */
export function ColorAvatarFallback({
  color,
  children,
}: {
  color?: string | null;
  children: React.ReactNode;
}) {
  const hex = color?.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) {
    return (
      <AvatarFallback className="bg-primary font-semibold text-primary-foreground text-sm">
        {children}
      </AvatarFallback>
    );
  }

  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  const foreground =
    luminance > Math.sqrt(0.0525) - 0.05 ? "#000000" : "#ffffff";

  return (
    <AvatarFallback
      className="bg-[var(--avatar-bg)] font-semibold text-[var(--avatar-fg)] text-sm"
      style={
        {
          "--avatar-bg": color,
          "--avatar-fg": foreground,
        } as React.CSSProperties
      }
    >
      {children}
    </AvatarFallback>
  );
}
