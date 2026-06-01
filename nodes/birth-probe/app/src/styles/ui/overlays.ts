// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui/overlays`
 * Purpose: Overlay component styling factories (terminals, modals, dialogs).
 * Scope: Provides CVA factories for overlay and interactive surface components. Does not handle positioning logic.
 * Invariants: All variants use design tokens; factories return valid Tailwind class strings; maintains z-index hierarchy.
 * Side-effects: none
 * Notes: Terminal components serve as reference for overlay patterns.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

import { cva } from "class-variance-authority";

import type { SizeKey } from "@/styles/theme";

const terminalFrameSurfaceVariants = {
  default: "bg-card text-card-foreground",
  muted: "bg-muted text-muted-foreground",
  inverse: "bg-primary text-primary-foreground",
} as const;

const terminalFrameSizeVariants = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
  xl: "text-lg",
} satisfies Record<SizeKey, string>;

/**
 * Terminal frame styling for code display and interactive terminals
 */
export const terminalFrame = cva("rounded-lg font-mono shadow-lg", {
  variants: {
    surface: terminalFrameSurfaceVariants,
    size: terminalFrameSizeVariants,
  },
  defaultVariants: {
    surface: "muted",
    size: "md",
  },
} as const);

const terminalDotColorVariants = {
  red: "bg-danger",
  yellow: "bg-warning",
  green: "bg-success",
} as const;

/**
 * Terminal dot styling for window controls
 */
export const terminalDot = cva("h-3 w-3 rounded-full", {
  variants: {
    color: terminalDotColorVariants,
  } as const,
  defaultVariants: {
    color: "red",
  },
});

/**
 * Terminal header styling for window controls bar
 */
export const terminalHeader = cva("mb-2 flex items-center justify-between p-6");

/**
 * Terminal body styling for content area
 */
export const terminalBody = cva("space-y-4 p-6");

/**
 * Icon button styling for interactive icons
 */
export const iconButton = cva(
  "text-muted-foreground transition-colors hover:text-foreground"
);

const iconToneVariants = {
  default: "",
  primary: "text-primary",
  muted: "text-muted-foreground",
  foreground: "text-foreground",
} as const;

const iconSizeVariants = {
  sm: "h-icon-sm w-icon-sm",
  md: "h-icon-md w-icon-md",
  lg: "h-icon-lg w-icon-lg",
  xl: "h-icon-xl w-icon-xl",
} satisfies Record<SizeKey, string>;

/**
 * Icon sizing variants for consistent icon dimensions
 */
export const icon = cva("", {
  variants: {
    size: iconSizeVariants,
    tone: iconToneVariants,
  } as const,
  defaultVariants: {
    size: "md",
    tone: "default",
  },
});

const themeIconStateVariants = {
  visible: "rotate-0 scale-100",
  hidden: "rotate-90 scale-0",
} as const;

/**
 * Theme icon animation for smooth transitions in ModeToggle
 */
export const themeIcon = cva("transition-all", {
  variants: {
    state: themeIconStateVariants,
  } as const,
  defaultVariants: {
    state: "visible",
  },
});

const revealStateVariants = {
  hidden: "opacity-0",
  visible: "opacity-100",
} as const;

const revealDurationVariants = {
  fast: "duration-150",
  normal: "duration-300",
  slow: "duration-500",
} as const;

const revealDelayVariants = {
  none: "",
  d150: "delay-150",
  d300: "delay-300",
  d450: "delay-[450ms]",
} as const;

/**
 * Reveal animation styling for progressive disclosure patterns
 */
export const reveal = cva("transition-opacity", {
  variants: {
    state: revealStateVariants,
    duration: revealDurationVariants,
    delay: revealDelayVariants,
  } as const,
  defaultVariants: {
    state: "visible",
    duration: "normal",
    delay: "none",
  },
});

const navLinkSizeVariants = {
  sm: "text-sm font-medium",
  md: "text-base font-medium",
  lg: "text-lg font-medium",
  xl: "text-xl font-medium",
} satisfies Record<SizeKey, string>;

const navLinkStateVariants = {
  default: "text-muted-foreground hover:text-foreground",
  hover: "text-foreground",
  active: "text-foreground font-semibold",
} as const;

/**
 * Navigation link styling for header and menu navigation
 */
export const navLink = cva("transition-colors", {
  variants: {
    size: navLinkSizeVariants,
    state: navLinkStateVariants,
  } as const,
  defaultVariants: {
    size: "sm",
    state: "default",
  },
});

const dropdownContentSizeVariants = {
  sm: "w-(--dropdown-sm)",
  md: "w-(--dropdown-md)",
  lg: "w-(--dropdown-lg)",
  xl: "w-(--dropdown-xl)",
} satisfies Record<SizeKey, string>;

/**
 * Dropdown menu content styling for consistent surface + sizing
 */
export const dropdownContent = cva(
  "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-overlay origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-hidden rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=open]:animate-in",
  {
    variants: {
      size: dropdownContentSizeVariants,
    } as const,
    defaultVariants: {
      size: "md",
    },
  }
);

/**
 * Dropdown menu item styling with icon and text layout
 */
export const dropdownMenuItem = cva(
  "relative flex cursor-default select-none items-center gap-4 rounded-sm px-4 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

const dropdownMenuCheckSizeVariants = {
  sm: "h-icon-sm w-icon-sm ml-auto",
  md: "h-icon-md w-icon-md ml-auto",
  lg: "h-icon-lg w-icon-lg ml-auto",
  xl: "h-icon-xl w-icon-xl ml-auto",
} satisfies Record<SizeKey, string>;

/**
 * Dropdown menu check icon styling with auto margin and sizing
 */
export const dropdownMenuCheck = cva("", {
  variants: {
    size: dropdownMenuCheckSizeVariants,
  } as const,
  defaultVariants: {
    size: "sm",
  },
});

/**
 * Chat container with flex column layout
 */
export const chatContainer = cva("flex h-full flex-col");

/**
 * Chat messages area - mobile fix: overflow-y-scroll for iOS momentum scrolling
 */
export const chatMessages = cva("flex-grow overflow-y-scroll p-6 sm:p-8");

/**
 * Individual chat message wrapper
 */
export const chatMessage = cva("mb-4");

/**
 * Visual divider between messages and input
 */
export const chatDivider = cva("h-px bg-border");

/**
 * Chat input form container with gap
 */
export const chatForm = cva("flex gap-4 p-6 sm:p-8");
