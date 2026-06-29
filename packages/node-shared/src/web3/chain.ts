// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/web3/chain`
 * Purpose: Canonical EVM blockchain network configuration for the deployment; single source of truth for all chain-specific values.
 * Scope: Exports chain ID, token addresses, explorer URLs, and payment constants; does not perform network calls or expose framework types (wagmi). EVM-only; Solana requires separate config.
 * Invariants: Single active chain per deployment; repo-spec chain_id must match CHAIN_ID or startup fails; all chain config in CHAINS map.
 * Side-effects: none
 * Links: docs/spec/chain-config.md, docs/spec/payments-design.md, src/shared/web3/evm-wagmi.ts (for wagmi Chain mapping)
 * @public
 */

/**
 * Supported EVM chain identifiers.
 */
export type ChainKey = "SEPOLIA" | "BASE";

/**
 * Chain configuration.
 * Framework-agnostic; no wagmi or other library types.
 * All chain-specific values must live here to avoid drift across parallel maps.
 * Note: Currently EVM-only; Solana would require separate config.
 */
export interface ChainConfig {
  /** Human-readable chain identifier */
  key: ChainKey;
  /** Chain ID (numeric) */
  chainId: number;
  /** Block explorer base URL (e.g., "https://sepolia.etherscan.io") */
  explorerBaseUrl: string;
  /** USDC token address on this chain */
  usdcTokenAddress: string;
  /** Minimum confirmations for payment verification */
  minConfirmations: number;
}

/**
 * Chain configurations for all supported chains.
 * Currently EVM-only; add new chains here; do not create separate parallel maps.
 */
export const CHAINS = {
  SEPOLIA: {
    key: "SEPOLIA",
    chainId: 11155111,
    explorerBaseUrl: "https://sepolia.etherscan.io",
    usdcTokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    minConfirmations: 2,
  },
  BASE: {
    key: "BASE",
    chainId: 8453,
    explorerBaseUrl: "https://basescan.org",
    usdcTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    minConfirmations: 2,
  },
} as const satisfies Record<ChainKey, ChainConfig>;

export type SupportedEvmChainId = (typeof CHAINS)[ChainKey]["chainId"];

export function isSupportedEvmChainId(
  chainId: number
): chainId is SupportedEvmChainId {
  return Object.values(CHAINS).some((chain) => chain.chainId === chainId);
}

export function getChainConfigById(chainId: SupportedEvmChainId): ChainConfig;
export function getChainConfigById(chainId: number): ChainConfig | null;
export function getChainConfigById(chainId: number): ChainConfig | null {
  return (
    Object.values(CHAINS).find((chain) => chain.chainId === chainId) ?? null
  );
}

/**
 * Active chain for this deployment.
 * This is the single switch that determines all chain-specific behavior.
 */
export const ACTIVE_CHAIN_KEY: ChainKey = "BASE";

/**
 * Active chain configuration.
 * All chain-specific values derive from this.
 */
export const CHAIN_CONFIG = CHAINS[ACTIVE_CHAIN_KEY];

/** Chain ID for the active network. Validated against repo-spec at startup. */
export const CHAIN_ID = CHAIN_CONFIG.chainId;

/**
 * Block explorer base URL for the active chain.
 */
export const BLOCK_EXPLORER_BASE_URL = CHAIN_CONFIG.explorerBaseUrl;

/**
 * USDC token address on the active network.
 */
export const USDC_TOKEN_ADDRESS = CHAIN_CONFIG.usdcTokenAddress;

/**
 * Minimum confirmations required for payment verification.
 * Transactions must have at least this many confirmations to be considered valid.
 */
export const MIN_CONFIRMATIONS = CHAIN_CONFIG.minConfirmations;

/**
 * Verification throttle in seconds (polling rate limit).
 * Minimum time between verification attempts to reduce RPC cost.
 */
export const VERIFY_THROTTLE_SECONDS = 10;

/**
 * Returns the active chain ID.
 * Provided for consistency; direct import of CHAIN_ID is preferred.
 */
export function getChainId(): number {
  return CHAIN_ID;
}
