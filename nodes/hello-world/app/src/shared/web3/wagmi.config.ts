// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/web3/wagmi.config`
 * Purpose: Static wagmi configuration for wallet connections with SSR support.
 * Scope: Server-importable. Built directly with `wagmi.createConfig` (no
 *   RainbowKit imports) so the server `layout.tsx` can import this module
 *   to compute `cookieToInitialState` without poisoning the RSC server
 *   module graph.
 * Invariants:
 *   - MUST NOT import from `@rainbow-me/rainbowkit` — that package is
 *     flagged `"use client"` and would break Next 15 static-page-data
 *     collection of framework routes (e.g. `/_not-found`).
 *   - SSR enabled with cookieStorage; single active chain (CHAIN);
 *     WalletConnect projectId from env (optional).
 * Side-effects: none (config creation only)
 * Notes: RainbowKit consumes this config inside the client `Providers`
 *   boundary via `<RainbowKitProvider>` — see `app/providers.client.tsx`.
 *   Pattern follows the canonical wagmi App Router SSR guide:
 *   https://wagmi.sh/react/guides/ssr and
 *   https://github.com/rainbow-me/rainbowkit/tree/main/examples/with-next-app
 * Follow-up: connectors registered here are `injected` + optional
 *   `walletConnect`. Coinbase Smart Wallet (`coinbaseWallet`) and Safe
 *   (`safe`) connectors from `wagmi/connectors` can be added when we have
 *   project credentials — see task.0402 §"Connector roster follow-up".
 *   `walletConnect({ showQrModal: true })` is intentional in this
 *   non-`getDefaultConfig` path: RainbowKit's modal only renders the QR
 *   when `rkDetails` flags are set (which only `getDefaultConfig` sets),
 *   so we let WC's own Web3Modal handle QR display.
 * @public
 */

import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

import { clientEnv } from "@/shared/env/client";
import { CHAIN } from "./evm-wagmi";

const projectId = clientEnv().NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

const connectors = [
  injected(),
  ...(projectId ? [walletConnect({ projectId, showQrModal: true })] : []),
];

/**
 * Static wagmi configuration for wallet connections.
 *
 * SSR-enabled with cookieStorage to prevent IndexedDB hydration errors.
 * WalletConnect projectId is optional — app degrades to injected wallet
 * (MetaMask, etc.) if missing.
 */
export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors,
  ssr: true,
  storage: createStorage({
    storage: cookieStorage,
  }),
  transports: {
    [CHAIN.id]: http(),
  },
});
