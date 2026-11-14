// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/web3/block-explorer`
 * Purpose: Block explorer URL utilities for viewing addresses and transactions on chain explorers.
 * Scope: Pure utility functions. Does not make network calls or access config directly.
 * Invariants: Returns null for unknown chains; reads explorer URLs from chain.ts CHAINS map.
 * Side-effects: none
 * Notes: All chain-specific config centralized in chain.ts; no parallel maps here.
 * Links: src/shared/web3/chain.ts, https://node-template.cognidao.org/knowledge/payments-usdc-verification-design
 * @public
 */

import { CHAINS } from "./chain";

/**
 * Maps chain ID to block explorer base URL.
 * Returns null for unsupported chains.
 */
function getBlockExplorerBase(chainId: number): string | null {
  // Find chain config by chainId
  const chainConfig = Object.values(CHAINS).find((c) => c.chainId === chainId);
  return chainConfig?.explorerBaseUrl ?? null;
}

/**
 * Generates block explorer URL for a given address on the specified chain.
 *
 * @param chainId - Chain ID (from chain.ts CHAINS map)
 * @param address - Ethereum address to view
 * @returns Block explorer URL or null if chain not supported
 */
export function getAddressExplorerUrl(
  chainId: number,
  address: string
): string | null {
  const base = getBlockExplorerBase(chainId);
  if (!base) return null;
  return `${base}/address/${address}`;
}

/**
 * Generates block explorer URL for a given transaction on the specified chain.
 *
 * @param chainId - Chain ID (from chain.ts CHAINS map)
 * @param txHash - Transaction hash to view
 * @returns Block explorer URL or null if chain not supported
 */
export function getTransactionExplorerUrl(
  chainId: number,
  txHash: string
): string | null {
  const base = getBlockExplorerBase(chainId);
  if (!base) return null;
  return `${base}/tx/${txHash}`;
}

/**
 * Maps chain ID to DAO platform network identifier.
 * Currently hardcoded to Aragon network identifiers.
 */
function getDaoNetworkId(chainId: number): string | null {
  const networkMap: Record<number, string> = {
    11155111: "ethereum-sepolia", // Sepolia testnet
    8453: "base-mainnet", // Base mainnet
  };
  return networkMap[chainId] ?? null;
}

/**
 * Generates DAO management app URL for a DAO address on the specified chain.
 * Currently hardcoded to Aragon app URLs.
 *
 * @param chainId - Chain ID (from chain.ts CHAINS map)
 * @param address - DAO address
 * @returns DAO app URL or null if chain not supported
 */
export function getDaoUrl(chainId: number, address: string): string | null {
  const network = getDaoNetworkId(chainId);
  if (!network) return null;
  return `https://app.aragon.org/dao/${network}/${address}`;
}

/**
 * Generates DAO treasury/assets URL for a DAO address on the specified chain.
 * Currently hardcoded to Aragon app URLs.
 *
 * @param chainId - Chain ID (from chain.ts CHAINS map)
 * @param address - DAO treasury address
 * @returns DAO assets URL or null if chain not supported
 */
export function getDaoTreasuryUrl(
  chainId: number,
  address: string
): string | null {
  const daoUrl = getDaoUrl(chainId, address);
  if (!daoUrl) return null;
  return `${daoUrl}/assets`;
}
