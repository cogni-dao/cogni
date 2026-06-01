// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/theme/SheetThemeToggle`
 * Purpose: Inline 3-button theme toggle for mobile Sheet navigation.
 * Scope: Provides segmented control for theme switching. Does not handle persistence (next-themes handles this).
 * Invariants: 44px touch targets; no nested dropdown; icons only; shows current theme selection.
 * Side-effects: global (theme state changes via setTheme)
 * Notes: Alternative to dropdown-based ModeToggle for Sheet footer; uses toggle-group primitive.
 * Links: src/components/kit/inputs/ModeToggle.tsx, next-themes documentation
 * @public
 */

"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@cogni/node-ui-kit/shadcn/toggle-group";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

export function SheetThemeToggle(): ReactElement {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Render placeholder during SSR to avoid hydration mismatch
    return (
      <ToggleGroup
        type="single"
        value="system"
        className="grid w-full grid-cols-3"
      >
        <ToggleGroupItem
          value="light"
          aria-label="Light theme"
          className="h-12 w-full"
        >
          <Sun className="h-5 w-5" />
        </ToggleGroupItem>
        <ToggleGroupItem
          value="dark"
          aria-label="Dark theme"
          className="h-12 w-full"
        >
          <Moon className="h-5 w-5" />
        </ToggleGroupItem>
        <ToggleGroupItem
          value="system"
          aria-label="System theme"
          className="h-12 w-full"
        >
          <Monitor className="h-5 w-5" />
        </ToggleGroupItem>
      </ToggleGroup>
    );
  }

  return (
    <ToggleGroup
      type="single"
      value={theme ?? "system"}
      onValueChange={(value) => {
        if (value) setTheme(value);
      }}
      className="grid w-full grid-cols-3"
    >
      <ToggleGroupItem
        value="light"
        aria-label="Light theme"
        className="h-12 w-full"
      >
        <Sun className="h-5 w-5" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="dark"
        aria-label="Dark theme"
        className="h-12 w-full"
      >
        <Moon className="h-5 w-5" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="system"
        aria-label="System theme"
        className="h-12 w-full"
      >
        <Monitor className="h-5 w-5" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
