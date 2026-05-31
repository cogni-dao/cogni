// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/navigation/MobileNav`
 * Purpose: Mobile-only Sheet navigation with hamburger trigger, nav links, GitHub link, and inline theme toggle.
 * Scope: Provides responsive navigation drawer (md:hidden). Does not handle routing logic or theme persistence.
 * Invariants: 40px touch target; SheetTitle for accessibility; 3-button theme toggle in footer.
 * Side-effects: global (theme changes via SheetThemeToggle)
 * Notes: Sheet w-48 sm:w-52 matches toggle grid; GitHub as link; theme pinned to footer.
 * Links: src/components/vendor/shadcn/sheet.tsx, src/components/kit/theme/SheetThemeToggle.tsx
 * @public
 */

"use client";

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@cogni/node-ui-kit/shadcn/sheet";
import { cn } from "@cogni/node-ui-kit/util/cn";
import { ExternalLink, Menu } from "lucide-react";
import type { ReactElement } from "react";
import { NavigationLink } from "@/components";
import { SheetThemeToggle } from "@/components/kit/theme/SheetThemeToggle";

interface MobileNavProps {
  readonly className?: string;
}

export function MobileNav({ className }: MobileNavProps): ReactElement {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground",
            className
          )}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </SheetTrigger>
      <SheetContent className="flex w-48 flex-col sm:w-52">
        <SheetTitle className="sr-only">Navigation menu</SheetTitle>
        <nav
          className="flex flex-col gap-4 py-4"
          aria-label="Mobile navigation"
        >
          <NavigationLink href="/chat">Chat</NavigationLink>
          <NavigationLink href="/work">Work</NavigationLink>
          <NavigationLink href="/activity">Activity</NavigationLink>
          <NavigationLink href="/gov">Gov</NavigationLink>
          <NavigationLink href="/credits">Credits</NavigationLink>
          <a
            href="https://github.com/cogni-DAO/cogni-template"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 font-medium text-muted-foreground text-sm transition-colors hover:text-foreground"
          >
            GitHub
            <ExternalLink className="h-4 w-4" />
          </a>
          <a
            href="https://discord.gg/3b9sSyhZ4z"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 font-medium text-muted-foreground text-sm transition-colors hover:text-foreground"
          >
            Discord
            <ExternalLink className="h-4 w-4" />
          </a>
        </nav>

        {/* Theme toggle in footer (OpenRouter-style) */}
        <div className="mt-auto border-border border-t pt-4">
          <SheetThemeToggle />
        </div>
      </SheetContent>
    </Sheet>
  );
}
