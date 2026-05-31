// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/web3/evm-wagmi`
 * Purpose: Wagmi adapter for EVM chain configuration; maps ChainConfig to wagmi Chain objects.
 * Scope: Wagmi-specific types and mappings. Does not contain business logic.
 * Invariants: Maps ACTIVE_CHAIN_KEY to corresponding wagmi Chain; used only by wagmi/RainbowKit setup.
 * Side-effects: none
 * Notes: This module exists to keep wagmi types out of core chain.ts config.
 * Links: src/shared/web3/chain.ts, src/app/providers/wallet.client.tsx
 * @public
 */

import { ACTIVE_CHAIN_KEY, type ChainKey } from "@cogni/node-shared";
import type { Chain } from "wagmi/chains";
import { base, sepolia } from "wagmi/chains";

/**
 * Maps ChainKey to wagmi Chain object.
 */
const WAGMI_CHAINS: Record<ChainKey, Chain> = {
  SEPOLIA: sepolia,
  BASE: base,
};

/**
 * Wagmi chain object for the active network.
 * Used by wagmi/RainbowKit configuration.
 */
export const CHAIN = WAGMI_CHAINS[ACTIVE_CHAIN_KEY];
