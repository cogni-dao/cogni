// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AppTopBar`
 * Purpose: Top bar for authenticated app pages with sidebar trigger, treasury, socials, and user avatar menu.
 * Scope: Renders top bar within SidebarInset. Does not handle authentication or sidebar state.
 * Invariants: SidebarTrigger requires SidebarProvider ancestor; socials visible lg+ only; avatar menu replaces wallet slot when authenticated.
 * Side-effects: none
 * Links: src/components/vendor/shadcn/sidebar.tsx, src/features/layout/components/AppHeader.tsx
 * @public
 */

"use client";

import { useSession } from "next-auth/react";
import type { ReactElement } from "react";
import { GithubButton, SidebarTrigger } from "@/components";
import { WalletConnectButton } from "@/components/kit/auth/WalletConnectButton";
import { TreasuryBadge } from "@/features/treasury/components/TreasuryBadge";
import { UserAvatarMenu } from "./UserAvatarMenu";

export function AppTopBar(): ReactElement {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";

  return (
    <header className="flex h-16 w-full shrink-0 items-center justify-between border-b px-3 md:px-6">
      <div className="flex items-center gap-3">
        <SidebarTrigger />
        <TreasuryBadge />
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        {/* Socials: visible lg+ */}
        <div className="hidden items-center gap-2 lg:flex">
          <a
            href="https://discord.gg/3b9sSyhZ4z"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-foreground transition-colors hover:text-muted-foreground"
            aria-label="Join our Discord"
          >
            <span className="sr-only">Join our Discord</span>
            <svg
              viewBox="0 0 127.14 96.36"
              fill="currentColor"
              className="size-5"
              aria-hidden="true"
            >
              <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z" />
            </svg>
          </a>
          <GithubButton
            username="cogni-DAO"
            repo="cogni-template"
            size="lg"
            variant="default"
            showGithubIcon={true}
            showStarIcon={true}
            initialStars={0}
            targetStars={172900}
            autoAnimate={true}
            animationDuration={10}
          />
        </div>

        {/* Auth slot: avatar menu when authenticated, wallet connect when not */}
        {isAuthenticated ? (
          <UserAvatarMenu />
        ) : (
          <>
            <WalletConnectButton variant="compact" className="sm:hidden" />
            <div data-wallet-slot="desktop" className="hidden sm:flex">
              <WalletConnectButton variant="default" />
            </div>
          </>
        )}
      </div>
    </header>
  );
}
