// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/auth/WalletConnectButton`
 * Purpose: Custom wallet connect button matching treasury badge design with hydration stability.
 *   Opens SignInDialog (wallet + OAuth options) instead of RainbowKit directly when not connected.
 * Scope: Client-side only. Used in header. Does not handle wallet selection UI or persistence.
 * Invariants: Treasury badge styling; min-width prevents CLS; ready/connected gates per RainbowKit docs.
 *   SIWE fallback: if wallet connected but not authenticated, shows "Sign message" CTA.
 * Side-effects: none
 * Notes: Uses ConnectButton.Custom for full styling control. No wagmi hooks (state from render props only).
 *        ready = mounted && authenticationStatus !== 'loading'
 *        connected = ready && account && chain && (!authenticationStatus || authenticationStatus === 'authenticated')
 * Links: docs/spec/authentication.md, https://rainbowkit.com/docs/custom-connect-button
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import type React from "react";
import { useState } from "react";

import { SignInDialog } from "./SignInDialog";

interface WalletConnectButtonProps {
  /**
   * Visual variant: 'compact' for mobile, 'default' for desktop.
   * Both use treasury badge styling; variant controls width only.
   */
  readonly variant?: "default" | "compact";
  /**
   * Optional className for layout adjustments
   */
  readonly className?: string;
}

/**
 * Base treasury badge styling - matches TreasuryBadge.tsx
 */
const BASE_BADGE_CLASSES =
  "flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm transition-colors hover:bg-accent";

/**
 * Custom wallet connect button matching treasury badge design.
 * Uses ConnectButton.Custom render props - no wagmi hooks inside component.
 */
export function WalletConnectButton({
  // variant = "default",
  className,
}: WalletConnectButtonProps = {}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className={cn("relative shrink-0", className)}>
      <ConnectButton.Custom>
        {({
          account,
          chain,
          mounted,
          authenticationStatus,
          openConnectModal,
          openAccountModal,
          openChainModal,
        }) => {
          // RainbowKit-prescribed ready/connected gates
          const ready = mounted && authenticationStatus !== "loading";
          const connected =
            ready &&
            account &&
            chain &&
            (!authenticationStatus || authenticationStatus === "authenticated");

          // Pre-ready: inert skeleton matching treasury badge structure
          if (!ready) {
            return (
              <div
                className={cn(
                  BASE_BADGE_CLASSES,
                  "pointer-events-none cursor-default"
                )}
                aria-hidden="true"
              >
                <span className="text-muted-foreground">Connect</span>
              </div>
            );
          }

          // Wallet connected but SIWE not completed — "Sign message" fallback
          if (account && authenticationStatus === "unauthenticated") {
            return (
              <button
                type="button"
                onClick={openConnectModal}
                className={cn(
                  BASE_BADGE_CLASSES,
                  "border-primary/50 bg-primary/5"
                )}
              >
                <span className="text-foreground">Sign message</span>
              </button>
            );
          }

          // Not connected: show connect button → opens our sign-in dialog
          if (!connected) {
            return (
              <>
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  className={BASE_BADGE_CLASSES}
                >
                  <span className="text-muted-foreground">Connect</span>
                </button>
                <SignInDialog
                  open={dialogOpen}
                  onOpenChange={setDialogOpen}
                  onWalletConnect={openConnectModal}
                />
              </>
            );
          }

          // Wrong network: destructive styling
          if (chain.unsupported) {
            return (
              <button
                type="button"
                onClick={openChainModal}
                className={cn(
                  BASE_BADGE_CLASSES,
                  "border-destructive bg-destructive/10"
                )}
              >
                <span className="text-destructive">Wrong network</span>
              </button>
            );
          }

          // Connected: show address only, same styling as Connect
          return (
            <button
              type="button"
              onClick={openAccountModal}
              className={BASE_BADGE_CLASSES}
            >
              <span className="text-muted-foreground">
                {account.displayName}
              </span>
            </button>
          );
        }}
      </ConnectButton.Custom>
    </div>
  );
}
