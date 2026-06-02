// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/layout`
 * Purpose: Root layout for the mochi (used as scaffold for new nodes) with font configuration and global styles.
 * Scope: Async server component. Reads request cookies, computes wagmi `initialState`,
 *   passes it to the client `Providers` so `<WagmiProvider>` hydrates without mismatch
 *   (per https://wagmi.sh/react/guides/ssr).
 * Invariants:
 *   - Stays a server component so `headers()` is callable cheaply.
 *   - `initialState` MUST be sourced from `cookieToInitialState(wagmiConfig, cookie)`.
 * Side-effects: reads request headers (Next.js dynamic API).
 * Links: ./providers.client, @/shared/web3/wagmi.config, docs/spec/architecture.md §SSR-unsafe libraries
 * @public
 */

import "@/styles/tailwind.css";
import "@rainbow-me/rainbowkit/styles.css";

import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import { headers } from "next/headers";
import Script from "next/script";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { cookieToInitialState } from "wagmi";

import { wagmiConfig } from "@/shared/web3/wagmi.config";
import { Providers } from "./providers.client";

const manrope = Manrope({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cogni",
  description: "Web3 Gov + Web2 AI",
};

// See operator/app/src/app/layout.tsx for rationale — `headers()` in the
// root layout requires dynamic rendering and the helper below tolerates the
// `/_not-found` build-time call where headers() throws.
export const dynamic = "force-dynamic";

async function readCookieHeaderSafely(): Promise<string | null> {
  try {
    return (await headers()).get("cookie");
  } catch {
    return null;
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const initialState = cookieToInitialState(
    wagmiConfig,
    await readCookieHeaderSafely()
  );

  return (
    <html lang="en" className={manrope.className} suppressHydrationWarning>
      <head>
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <Providers initialState={initialState}>
            <div id="main">{children}</div>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
