// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/web3/node-formation`
 * Purpose: Node Formation (P0) chain constants.
 * Scope: Pure constants only; does not read env or make RPC calls.
 * Invariants: Must match deployed contracts on the selected chain.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

export const SUPPORTED_CHAIN_IDS = [8453, 84532, 11155111] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

type HexAddress = `0x${string}`;

export const ARAGON_OSX_ADDRESSES: Record<
  SupportedChainId,
  {
    daoFactory: HexAddress;
    pluginSetupProcessor: HexAddress;
    tokenVotingPluginRepo: HexAddress;
  }
> = {
  // Base Mainnet (8453) - OSx v1.4.0
  8453: {
    daoFactory: "0xcc602EA573a42eBeC290f33F49D4A87177ebB8d2",
    pluginSetupProcessor: "0x91a851E9Ed7F2c6d41b15F76e4a88f5A37067cC9",
    tokenVotingPluginRepo: "0x2532570DcFb749A7F976136CC05648ef2a0f60b0",
  },

  // Base Sepolia (84532) - OSx v1.4.0
  84532: {
    daoFactory: "0x016CBa9bd729C30b16849b2c52744447767E9dab",
    pluginSetupProcessor: "0xd97D409Ca645b108468c26d8506f3a4Bf9D0BE81",
    tokenVotingPluginRepo: "0xdEbcF8779495a62156c6d1416628F60525984e9d",
  },

  // Sepolia (11155111) - OSx v1.4.0
  11155111: {
    daoFactory: "0xB815791c233807D39b7430127975244B36C19C8e",
    pluginSetupProcessor: "0xC24188a73dc09aA7C721f96Ad8857B469C01dC9f",
    tokenVotingPluginRepo: "0x424F4cA6FA9c24C03f2396DF0E96057eD11CF7dF",
  },
} as const;

export const TOKEN_VOTING_VERSION_TAG = {
  // TokenVoting v1.4.0 per spec
  release: 1,
  build: 4,
} as const;
