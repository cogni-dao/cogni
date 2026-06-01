// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/treasury-read`
 * Purpose: Treasury balance read port for on-chain treasury snapshots.
 * Scope: Read-only interface for querying treasury balances. Chain-agnostic. Does not implement queries or handle HTTP.
 * Invariants: Port is read-only (no mutations); adapter handles EVM vs Solana vs other chains.
 * Side-effects: none (interface definition only)
 * Notes: Phase 2: ETH balance only via ViemTreasuryAdapter. Future: multi-token support.
 * Links: docs/spec/onchain-readers.md
 * @public
 */

/**
 * Token balance in a treasury snapshot
 */
export interface TokenBalance {
  /** Token symbol (e.g., 'ETH', 'USDC') */
  token: string;
  /** Token address (null for native token like ETH) */
  tokenAddress: string | null;
  /** Balance in smallest unit (wei for ETH) */
  balanceWei: bigint;
  /** Balance formatted as decimal string */
  balanceFormatted: string;
  /** Token decimals (18 for ETH, 6 for USDC) */
  decimals: number;
}

/**
 * Treasury snapshot containing balances at a specific block
 */
export interface TreasurySnapshot {
  /** Treasury address queried */
  treasuryAddress: string;
  /** Chain ID where treasury exists */
  chainId: number;
  /** Block number at query time */
  blockNumber: bigint;
  /** Array of token balances */
  balances: TokenBalance[];
  /** Timestamp when snapshot was taken */
  timestamp: number;
}

/**
 * Treasury read port for querying on-chain treasury balances.
 * Read-only interface; adapter handles chain-specific implementation.
 */
export interface TreasuryReadPort {
  /**
   * Gets treasury balance snapshot for specified address and tokens.
   *
   * @param params - Query parameters
   * @param params.chainId - Chain ID (e.g., 11155111 for Sepolia)
   * @param params.treasuryAddress - Treasury wallet address
   * @param params.tokenAddresses - Optional array of token addresses; empty = native token (ETH) only
   * @returns Treasury snapshot with balances
   */
  getTreasurySnapshot(params: {
    chainId: number;
    treasuryAddress: string;
    tokenAddresses?: string[];
  }): Promise<TreasurySnapshot>;
}
