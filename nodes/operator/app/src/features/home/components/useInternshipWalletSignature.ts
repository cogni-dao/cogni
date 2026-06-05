// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/useInternshipWalletSignature`
 * Purpose: Small public-form wallet signing hook for internship applications.
 * Scope: Wraps RainbowKit connect modal and wagmi signMessage for unauthenticated applicants.
 * Invariants: Does not create Cogni sessions; signs caller-provided messages only.
 * Side-effects: browser wallet connection and message signing
 * Links: contracts/internship.interest.v1.contract.ts
 * @public
 */

"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage } from "wagmi";

export function useInternshipWalletSignature(): {
  readonly address: `0x${string}` | undefined;
  readonly isConnected: boolean;
  readonly isSigning: boolean;
  readonly openConnectModal: (() => void) | undefined;
  readonly signMessage: (message: string) => Promise<`0x${string}`>;
} {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();

  return {
    address,
    isConnected,
    isSigning,
    openConnectModal,
    signMessage: (message: string) => signMessageAsync({ message }),
  };
}
