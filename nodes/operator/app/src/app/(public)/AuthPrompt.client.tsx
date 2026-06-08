// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/AuthPrompt`
 * Purpose: Handles public-page sign-in intents produced by proxy-protected app routes.
 * Scope: Client island. Opens the existing sign-in dialog when the URL requests sign-in,
 *   then redirects authenticated users to the validated callback target.
 * Side-effects: auth modal IO, navigation
 * Links: src/proxy.ts, src/components/kit/auth/SignInDialog.tsx
 * @public
 */

"use client";

import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { SignInDialog } from "@/components/kit/auth/SignInDialog";

const DEFAULT_CALLBACK_URL = "/chat";
const SIGN_IN_PARAM = "signIn";
const CALLBACK_PARAM = "callbackUrl";
const APP_CALLBACK_ROUTES = [
  "/activity",
  "/chat",
  "/credits",
  "/dashboard",
  "/gov",
  "/knowledge",
  "/nodes",
  "/profile",
  "/schedules",
  "/setup",
  "/work",
] as const;

function isAppCallbackPath(pathname: string): boolean {
  return APP_CALLBACK_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
}

function normalizeCallbackUrl(value: string | null): string {
  if (!value) return DEFAULT_CALLBACK_URL;
  if (!value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_CALLBACK_URL;
  }

  try {
    const url = new URL(value, "https://cognidao.local");
    if (!isAppCallbackPath(url.pathname)) {
      return DEFAULT_CALLBACK_URL;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
}

export function AuthPrompt(): ReactElement | null {
  const searchParams = useSearchParams();
  const { status } = useSession();
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const shouldPrompt = searchParams.get(SIGN_IN_PARAM) === "1";
  const callbackUrl = useMemo(
    () => normalizeCallbackUrl(searchParams.get(CALLBACK_PARAM)),
    [searchParams]
  );
  const [dialogOpen, setDialogOpen] = useState(shouldPrompt);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (shouldPrompt && status === "unauthenticated") {
      setDialogOpen(true);
    }
  }, [shouldPrompt, status]);

  useEffect(() => {
    if (status !== "authenticated") return;

    setRedirecting(true);
    window.location.replace(shouldPrompt ? callbackUrl : DEFAULT_CALLBACK_URL);
  }, [callbackUrl, shouldPrompt, status]);

  function handleWalletConnect(): void {
    if (!isConnected) {
      openConnectModal?.();
      return;
    }

    openAccountModal?.();
  }

  return (
    <>
      {redirecting ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
          <p className="text-muted-foreground text-sm">Redirecting...</p>
        </div>
      ) : null}
      <SignInDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onWalletConnect={handleWalletConnect}
        callbackUrl={callbackUrl}
      />
    </>
  );
}
