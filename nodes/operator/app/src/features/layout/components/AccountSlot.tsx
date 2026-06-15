// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AccountSlot`
 * Purpose: Shared account chrome for public and authenticated headers.
 * Scope: Renders a session-aware auth slot. Wallet state is only used for sign-in when no
 *   NextAuth session exists; authenticated users always see the user menu.
 * Side-effects: none
 * Links: src/features/layout/components/AppHeader.tsx, src/features/layout/components/AppTopBar.tsx
 * @public
 */

"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import type { ReactElement } from "react";

import { Button } from "@/components";
import { WalletConnectButton } from "@/components/kit/auth/WalletConnectButton";

import { UserAvatarMenu } from "./UserAvatarMenu";

interface AccountSlotProps {
  readonly showAppLink?: boolean;
}

function AccountSkeleton(): ReactElement {
  return (
    <div
      className="h-8 w-20 rounded-full border border-border bg-muted/50"
      aria-hidden="true"
    />
  );
}

export function AccountSlot({
  showAppLink = false,
}: AccountSlotProps): ReactElement {
  const { status } = useSession();

  if (status === "loading") {
    return <AccountSkeleton />;
  }

  if (status === "authenticated") {
    return (
      <div className="flex items-center gap-2">
        {showAppLink ? (
          <Button
            asChild
            variant="secondary"
            size="sm"
            className="hidden sm:flex"
          >
            <Link href="/chat">Open app</Link>
          </Button>
        ) : null}
        <UserAvatarMenu />
      </div>
    );
  }

  return (
    <>
      <WalletConnectButton variant="compact" className="sm:hidden" />
      <div data-wallet-slot="desktop" className="hidden sm:flex">
        <WalletConnectButton variant="default" />
      </div>
    </>
  );
}
