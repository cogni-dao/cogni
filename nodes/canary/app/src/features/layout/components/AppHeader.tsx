// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AppHeader`
 * Purpose: Application header for canary — shell mark, treasury, links, wallet, theme.
 * Scope: Public-page header. Node-specific branding for the claw / molt lineage.
 * Invariants: No horizontal overflow; wallet/theme behavior matches shared shell conventions.
 * Side-effects: none
 * Links: docs/guides/new-node-styling.md
 * @public
 */

"use client";

import { ExternalLink, Github, Shell } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import { ModeToggle } from "@/components";
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
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <nav
            aria-label="Primary"
            className="flex min-w-0 items-center gap-3 sm:gap-4"
          >
            <Link
              href="/"
              aria-current="page"
              className="flex min-w-0 items-center gap-2 pl-4 sm:pl-0"
            >
              <Shell className="size-5 shrink-0 text-primary" />
              <span className="hidden truncate font-bold text-xl md:inline">
                cogni<span className="text-primary">/canary</span>
              </span>
            </Link>

            <div className="flex">
              <TreasuryBadge />
            </div>
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden items-center gap-3 lg:flex">
              <a
                href="https://github.com/openclaw/openclaw"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="OpenClaw on GitHub"
                className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Github className="size-4" strokeWidth={1.5} aria-hidden="true" />
                <span className="text-sm">OpenClaw</span>
              </a>
              <a
                href="https://clawhub.com"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open ClawHub"
                className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="size-4" strokeWidth={1.5} aria-hidden="true" />
                <span className="text-sm">ClawHub</span>
              </a>
            </div>

            <WalletConnectButton variant="compact" className="sm:hidden" />
            <div data-wallet-slot="desktop" className="hidden sm:flex">
              <WalletConnectButton variant="default" />
            </div>

            <ModeToggle className="hidden md:flex" />
          </div>
        </div>
      </div>
    </header>
  );
}
