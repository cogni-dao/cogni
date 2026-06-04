// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/providers.client`
 * Purpose: Client boundary composing platform providers with node-local wagmiConfig.
 * Scope: Composes Wagmi + Auth + Query + RainbowKit/SIWE in the canonical order
 *   prescribed by RainbowKit (https://rainbowkit.com/docs/authentication):
 *   WagmiProvider (outermost) → SessionProvider (via @cogni/node-app AuthProvider) →
 *   QueryClientProvider → RainbowKitSiweNextAuthProvider → RainbowKitProvider.
 * Invariants:
 *   - WagmiProvider receives `initialState` from `cookieToInitialState` in the server
 *     layout — required for SSR hydration without mismatch.
 *   - WagmiProvider is the outermost provider so Wagmi state is available to every
 *     descendant and `cookieToInitialState` hydrates a single root.
 *   - RainbowKitSiweNextAuthProvider remains a descendant of SessionProvider so it
 *     can read the next-auth session.
 * Side-effects: none
 * Links: layout.tsx, packages/node-app/src/providers/, src/shared/web3/wagmi.config.ts
 * @public
 */

"use client";

import {
  AuthProvider,
  createAppDarkTheme,
  createAppLightTheme,
  QueryProvider,
} from "@cogni/node-app/providers";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { RainbowKitSiweNextAuthProvider } from "@rainbow-me/rainbowkit-siwe-next-auth";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { type State, WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/shared/web3/wagmi.config";

function RainbowKitThemeProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const theme = useMemo(
    () =>
      mounted && resolvedTheme === "light"
        ? createAppLightTheme()
        : createAppDarkTheme(),
    [mounted, resolvedTheme]
  );

  return <RainbowKitProvider theme={theme}>{children}</RainbowKitProvider>;
}

export function Providers({
  children,
  initialState,
}: {
  readonly children: ReactNode;
  readonly initialState?: State | undefined;
}): ReactNode {
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <AuthProvider>
        <QueryProvider>
          <RainbowKitSiweNextAuthProvider
            getSiweMessageOptions={() => ({
              statement: "Sign in with Ethereum to the app.",
            })}
          >
            <RainbowKitThemeProvider>{children}</RainbowKitThemeProvider>
          </RainbowKitSiweNextAuthProvider>
        </QueryProvider>
      </AuthProvider>
    </WagmiProvider>
  );
}
