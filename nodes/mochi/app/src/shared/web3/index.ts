// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/web3`
 * Purpose: Barrel export — combines app-local wagmi config + extracted (@cogni/node-shared) chain constants.
 * Scope: Re-exports chain config, ABIs, block explorer URLs, and wagmi adapter.
 * Invariants: none
 * Side-effects: none
 * @public
 */

// Extracted to @cogni/node-shared
export {
  // Chain constants
  ACTIVE_CHAIN_KEY,
  // Node formation
  ARAGON_OSX_ADDRESSES,
  CHAIN_ID,
  CHAINS,
  type ChainKey,
  DAO_FACTORY_ABI,
  // ERC20 ABI
  ERC20_ABI,
  GOVERNANCE_ERC20_ABI,
  // Block explorer
  getDaoTreasuryUrl,
  getTransactionExplorerUrl,
  SUPPORTED_CHAIN_IDS,
  type SupportedChainId,
  TOKEN_VOTING_ABI,
  TOKEN_VOTING_VERSION_TAG,
  USDC_TOKEN_ADDRESS,
  VERIFY_THROTTLE_SECONDS,
} from "@cogni/node-shared";
// App-local (wagmi/chains runtime dep)
export * from "./evm-wagmi";
