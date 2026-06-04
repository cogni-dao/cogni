// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/auth/SignInDialog`
 * Purpose: Modal dialog presenting sign-in options: Ethereum wallet, GitHub, Google.
 * Scope: Client component that fetches available providers and renders sign-in options; does not manage session state or implement OAuth flow directly.
 * Invariants: Only renders providers that are actually configured server-side.
 *   Filters out "credentials" (SIWE) since wallet flow is handled separately.
 * Side-effects: IO (fetch /api/auth/providers, signIn redirect)
 * Links: src/components/kit/auth/WalletConnectButton.tsx, src/auth.ts
 * @public
 */

"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cogni/node-ui-kit/shadcn/dialog";
import { signIn } from "next-auth/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import {
  EthereumIcon,
  GitHubIcon,
  GoogleIcon,
} from "@/components/kit/data-display/ProviderIcons";
import { Button } from "@/components/kit/inputs/Button";

/** Provider metadata for rendering sign-in buttons */
const OAUTH_PROVIDERS = [
  {
    id: "github",
    label: "Continue with GitHub",
    icon: GitHubIcon,
  },
  {
    id: "google",
    label: "Continue with Google",
    icon: GoogleIcon,
  },
] as const;

interface SignInDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called when user picks the Ethereum wallet option */
  readonly onWalletConnect: () => void;
}

export function SignInDialog({
  open,
  onOpenChange,
  onWalletConnect,
}: SignInDialogProps): ReactElement {
  // Optimistic: show all known OAuth buttons immediately to avoid pop-in lag.
  // The fetch narrows the set if a provider isn't configured server-side.
  const [availableProviders, setAvailableProviders] = useState<Set<string>>(
    () => new Set(OAUTH_PROVIDERS.map((p) => p.id))
  );

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    fetch("/api/auth/providers")
      .then((res) => res.json())
      .then((providers: Record<string, { id: string }>) => {
        if (cancelled) return;
        const ids = new Set(
          Object.keys(providers).filter((id) => id !== "credentials")
        );
        setAvailableProviders(ids);
      })
      .catch(() => {
        // If provider fetch fails, keep the optimistic set
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in to Cogni</DialogTitle>
          <DialogDescription>Choose a method to get started.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-2">
          {/* Wallet option — always available */}
          <Button
            variant="outline"
            className="h-12 justify-start gap-3 text-sm"
            onClick={() => {
              onOpenChange(false);
              onWalletConnect();
            }}
          >
            <EthereumIcon className="size-5" />
            Ethereum Wallet
          </Button>

          {/* OAuth options — only if provider is configured */}
          {OAUTH_PROVIDERS.filter((p) => availableProviders.has(p.id)).map(
            (provider) => (
              <Button
                key={provider.id}
                variant="outline"
                className="h-12 justify-start gap-3 text-sm"
                onClick={() => signIn(provider.id, { callbackUrl: "/chat" })}
              >
                <provider.icon className="size-5" />
                {provider.label}
              </Button>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
