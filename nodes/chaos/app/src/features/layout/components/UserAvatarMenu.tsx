// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/UserAvatarMenu`
 * Purpose: Authenticated user avatar dropdown with profile link, sign out, and theme toggle.
 * Scope: Client component rendering avatar trigger + dropdown menu. Does not fetch profile data (uses session).
 * Invariants: Requires session with user.id; falls back to "?" when no display name available.
 * Side-effects: IO (signOut, theme changes via next-themes, navigation)
 * Links: src/components/kit/data-display/Avatar.tsx
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { LogOut, Monitor, Moon, Sun, User } from "lucide-react";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { useDisconnect } from "wagmi";
import { Avatar, AvatarFallback } from "@/components/kit/data-display/Avatar";
import { EthereumIcon } from "@/components/kit/data-display/ProviderIcons";

/** Default avatar color when none is set */
const DEFAULT_AVATAR_COLOR = "hsl(var(--primary))";

// Radix animation classes for dropdown content
const DROPDOWN_CONTENT_CLASSES =
  "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-overlay origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-hidden rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=open]:animate-in w-32";

const MENU_ITEM_CLASSES =
  "group mx-1 flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm outline-none transition-colors hover:bg-accent focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

function truncateWallet(address: string): string {
  if (address.length <= 9) return address;
  return `${address.slice(0, 4)}…${address.slice(-3)}`;
}

export function UserAvatarMenu(): ReactElement | null {
  const { data: session } = useSession();
  const { disconnect } = useDisconnect();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!session?.user) return null;

  const { user } = session;
  const displayName =
    user.displayName ||
    user.name ||
    (user.walletAddress ? truncateWallet(user.walletAddress) : "User");
  const avatarLetter = displayName.charAt(0).toUpperCase();
  const avatarColor = user.avatarColor || DEFAULT_AVATAR_COLOR;

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className="flex items-center rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="User menu"
        >
          <Avatar
            className="size-8"
            style={{ "--avatar-bg": avatarColor } as React.CSSProperties}
          >
            <AvatarFallback className="bg-[var(--avatar-bg)] font-semibold text-primary-foreground text-sm">
              {avatarLetter}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={8}
          className={DROPDOWN_CONTENT_CLASSES}
        >
          {/* Wallet / identifier row */}
          {displayName && (
            <DropdownMenuPrimitive.Item className={MENU_ITEM_CLASSES} disabled>
              <EthereumIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{displayName}</span>
            </DropdownMenuPrimitive.Item>
          )}

          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />

          {/* Profile link */}
          <DropdownMenuPrimitive.Item asChild>
            <Link href="/profile" className={MENU_ITEM_CLASSES}>
              <User className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              <span>Profile</span>
            </Link>
          </DropdownMenuPrimitive.Item>

          {/* Sign out */}
          <DropdownMenuPrimitive.Item
            className={MENU_ITEM_CLASSES}
            onClick={() => {
              disconnect();
              signOut({ callbackUrl: "/" });
            }}
          >
            <LogOut className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            <span>Sign Out</span>
          </DropdownMenuPrimitive.Item>

          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />

          {/* Theme toggle — pill selector */}
          {mounted && (
            <div className="mx-1 my-1 flex items-center rounded-lg border border-border bg-muted/50 p-1">
              <button
                type="button"
                onClick={() => setTheme("light")}
                className={cn(
                  "flex flex-1 items-center justify-center rounded-md py-1.5 transition-colors",
                  theme === "light"
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:bg-accent/50"
                )}
                aria-label="Light theme"
              >
                <Sun className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setTheme("dark")}
                className={cn(
                  "flex flex-1 items-center justify-center rounded-md py-1.5 transition-colors",
                  theme === "dark"
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:bg-accent/50"
                )}
                aria-label="Dark theme"
              >
                <Moon className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setTheme("system")}
                className={cn(
                  "flex flex-1 items-center justify-center rounded-md py-1.5 transition-colors",
                  theme === "system"
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:bg-accent/50"
                )}
                aria-label="System theme"
              >
                <Monitor className="size-4" />
              </button>
            </div>
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
