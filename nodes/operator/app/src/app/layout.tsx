// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/layout`
 * Purpose: Root layout component for Next.js App Router with font configuration and global styles.
 * Scope: Async server component. Reads request cookies, computes wagmi `initialState`,
 *   passes it to the client `Providers` so `<WagmiProvider>` hydrates without mismatch
 *   (per https://wagmi.sh/react/guides/ssr).
 * Invariants:
 *   - Stays a server component (no "use client") so `headers()` is callable cheaply.
 *   - `initialState` MUST be sourced from `cookieToInitialState(wagmiConfig, cookie)` —
 *     anything else triggers React hydration-mismatch warnings on authed loads.
 * Side-effects: reads request headers (Next.js dynamic API).
 * Links: ./providers.client, @/shared/web3/wagmi.config, https://node-template.cognidao.org/knowledge/hexagonal-layering-contract §SSR-unsafe libraries
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

// Reading `headers()` in the root layout makes every route dynamic; this
// export makes that explicit. Next still collects page data for the framework's
// `/_not-found` route during build — see `readCookieHeaderSafely` below for
// why we tolerate `headers()` throwing in that path.
// https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#dynamic
export const dynamic = "force-dynamic";

/**
 * `headers()` throws `DynamicServerError` when invoked outside a request
 * context — Next's `/_not-found` data-collection pass during `next build` is
 * one such path. Returning `null` lets `cookieToInitialState` fall back to an
 * empty wagmi state for that build-time pass; at runtime the cookie is read
 * normally and hydration matches the client's cookie-stored wallet state.
 */
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
