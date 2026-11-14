// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/aragon`
 * Purpose: Aragon OSx address/config constants for Node Formation P0.
 * Scope: Pure constants only; does not make RPC calls or access env.
 * Invariants: Addresses must match the chain deployment.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

import type { HexAddress } from "./types";

export type AragonOsxAddresses = {
  daoFactory: HexAddress;
  pluginSetupProcessor: HexAddress;
  tokenVotingPluginRepo: HexAddress;
};

// Only BASE and SEPOLIA supported (matches chain.ts)
export const SUPPORTED_CHAIN_IDS = [8453, 11155111] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

/**
 * Hardcoded addresses from https://cognidao.org/knowledge/node-formation-contract (Appendix).
 * OSx v1.4.0 deployments.
 */
export const ARAGON_OSX_ADDRESSES: Record<
  SupportedChainId,
  AragonOsxAddresses
> = {
  // Base Mainnet (8453)
  8453: {
    daoFactory: "0xcc602EA573a42eBeC290f33F49D4A87177ebB8d2",
    pluginSetupProcessor: "0x91a851E9Ed7F2c6d41b15F76e4a88f5A37067cC9",
    tokenVotingPluginRepo: "0x2532570DcFb749A7F976136CC05648ef2a0f60b0",
  },

  // Sepolia (11155111)
  11155111: {
    daoFactory: "0xB815791c233807D39b7430127975244B36C19C8e",
    pluginSetupProcessor: "0xC24188a73dc09aA7C721f96Ad8857B469C01dC9f",
    tokenVotingPluginRepo: "0x424F4cA6FA9c24C03f2396DF0E96057eD11CF7dF",
  },
} as const;

export function getAragonAddresses(chainId: number): AragonOsxAddresses {
  if (!(SUPPORTED_CHAIN_IDS as readonly number[]).includes(chainId)) {
    throw new Error(`[aragon-osx] Unsupported chainId: ${chainId}`);
  }
  return ARAGON_OSX_ADDRESSES[chainId as SupportedChainId];
}
