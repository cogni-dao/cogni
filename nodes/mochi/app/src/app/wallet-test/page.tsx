// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/wallet-test/page`
 * Purpose: Dev-test page for verifying SIWE authentication flow with NextAuth.
 * Scope: Client component that demonstrates WalletConnectButton with error display. Uses kit component for reusable auth logic. Does not implement wallet logic directly.
 * Invariants: None (delegates to WalletConnectButton)
 * Side-effects: IO (via WalletConnectButton)
 * Notes: Test harness for proper Web3 UX. Wallet address is canonical user identity for MVP.
 * Links: https://www.rainbowkit.com/docs/connect-button, docs/spec/security-auth.md
 * @public
 */

// TODO: DELETE after Stage 2 complete - temporary test harness only

"use client";

import type { ReactNode } from "react";

import { WalletConnectButton } from "@/components";

export default function WalletTestPage(): ReactNode {
  return (
    <div className="flex flex-col gap-[var(--spacing-md)] p-[var(--spacing-lg)]">
      <h1 className="font-[var(--font-weight-bold)] text-[length:var(--font-size-xl)]">
        Wallet Connection Test
      </h1>
      <WalletConnectButton />
    </div>
  );
}
