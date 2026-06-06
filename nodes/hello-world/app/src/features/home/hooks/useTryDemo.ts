// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/hooks/useTryDemo`
 * Purpose: Handle "Try Demo" authentication flow before navigating to /chat.
 * Scope: Homepage only. Opens RainbowKit modals for auth, then navigates on success. Does not handle auth UI rendering.
 * Invariants: No navigation until authenticated; uses existing RainbowKit + SIWE flow; persists redirect intent in sessionStorage.
 * Side-effects: IO (opens modals, navigates via router, writes sessionStorage)
 * Notes: Prevents redirect loop by completing auth BEFORE pushing to /chat. Uses sessionStorage to survive SIWE redirects.
 * Links: src/features/home/components/NewHomeHero.tsx, src/app/providers/wallet.client.tsx
 * @public
 */

"use client";

import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect } from "react";
import { useAccount } from "wagmi";

const REDIRECT_KEY = "postAuthRedirect";

export function useTryDemo() {
  const router = useRouter();
  const { status } = useSession();
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();

  // Check for pending redirect after authentication
  useEffect(() => {
    if (status !== "authenticated") return;

    const next = sessionStorage.getItem(REDIRECT_KEY);
    if (!next) return;

    sessionStorage.removeItem(REDIRECT_KEY);
    router.push(next);
  }, [status, router]);

  const handleTryDemo = useCallback(() => {
    // Already authenticated: navigate immediately
    if (status === "authenticated") {
      router.push("/chat");
      return;
    }

    // Store redirect intent in sessionStorage (survives SIWE flow)
    sessionStorage.setItem(REDIRECT_KEY, "/chat");

    // Not connected: open connect modal
    if (!isConnected) {
      openConnectModal?.();
      return;
    }

    // Connected but not authenticated: open account modal for SIWE verification
    openAccountModal?.();
  }, [status, isConnected, openConnectModal, openAccountModal, router]);

  return { handleTryDemo };
}
