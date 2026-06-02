// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AppHeader`
 * Purpose: Application header composing kit components and feature-specific widgets.
 * Scope: Public-page header. Renders logo, treasury, socials, wallet, theme toggle. Nav links removed — signed-in users use the sidebar. Does not handle routing or analytics.
 * Invariants: No horizontal overflow; min-w-0/truncate/shrink-0 guards; GitHub hidden <lg; theme hidden <md; treasury always visible.
 * Side-effects: none
 * Notes: Desktop wallet in [data-wallet-slot="desktop"] for CSS (see tailwind.css).
 *        Lives in features/layout as app-shell composition that knows about treasury, wallet, etc.
 * Links: src/components/kit/auth/WalletConnectButton.tsx, src/styles/tailwind.css, docs/spec/onchain-readers.md
 * @public
 */

"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";

import { GithubButton, ModeToggle } from "@/components";
import { WalletConnectButton } from "@/components/kit/auth/WalletConnectButton";
import { TreasuryBadge } from "@/features/treasury/components/TreasuryBadge";

export function AppHeader(): ReactElement {
  return (
    <header className="border-border border-b bg-background py-3">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-background focus:p-2 focus:text-foreground"
      >
        Skip to main content
      </a>
      {/* Container: matches max-w-7xl pattern from Credits page */}
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          {/* Left side: Logo + Treasury */}
          <nav
            aria-label="Primary"
            className="flex min-w-0 items-center gap-3 sm:gap-4"
          >
            <Link
              href="/"
              aria-current="page"
              className="flex min-w-0 items-center gap-2 pl-4 sm:pl-0"
            >
              <Image
                src="/TransparentBrainOnly.png"
                alt="Cogni Brain Logo"
                width={24}
                height={24}
                className="shrink-0"
              />
              <span className="hidden truncate font-bold text-gradient-accent text-xl md:inline">
                Cogni
              </span>
            </Link>

            {/* Treasury: visible on all screen sizes */}
            <div className="flex">
              <TreasuryBadge />
            </div>
          </nav>

          {/* Action buttons */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-3">
            {/* GitHub + Discord: only visible lg+ */}
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
                label="cogni-template"
                initialStars={0}
                targetStars={172900}
                autoAnimate={true}
                animationDuration={10}
              />
            </div>

            {/* Wallet: CSS-gated instances (compact on mobile, default on desktop) */}
            <WalletConnectButton variant="compact" className="sm:hidden" />
            <div data-wallet-slot="desktop" className="hidden sm:flex">
              <WalletConnectButton variant="default" />
            </div>

            {/* Theme toggle */}
            <ModeToggle className="hidden md:flex" />
          </div>
        </div>
      </div>
    </header>
  );
}
