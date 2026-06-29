// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/osx/version`
 * Purpose: Pinned OSx version constants for TokenVoting plugin.
 * Scope: Pure constants; does not make RPC calls.
 * Invariants: Version tags must match deployed OSx infrastructure.
 * Side-effects: none
 * Links: docs/spec/node-formation.md
 * @public
 */

/**
 * TokenVoting plugin version tag for OSx v1.4.0 deployments.
 * release=1, build=3 matches cogni-gov-contracts Foundry script.
 */
export const TOKEN_VOTING_VERSION_TAG = {
  release: 1,
  build: 3,
} as const;

/**
 * MintSettings encoding version.
 *
 * OSx v1.3: (address[] receivers, uint256[] amounts)
 * OSx v1.4: (address[] receivers, uint256[] amounts, bool ensureDelegationOnMint)
 *
 * Foundry script uses v1.4 struct with ensureDelegationOnMint field.
 * Matches GovernanceERC20.MintSettings in token-voting-plugin.
 */
export const MINT_SETTINGS_VERSION = "v1.4" as const;

/**
 * Default TokenVoting configuration matching NODE_FORMATION_SPEC.md §3.
 * These values should NOT be changed without explicit governance decision.
 */
export const DEFAULT_VOTING_SETTINGS = {
  /** EarlyExecution mode (1) - proposals execute once threshold met */
  votingMode: 1,
  /** 50% support threshold (1e6 precision) */
  supportThreshold: 500_000,
  /** 50% minimum participation (1e6 precision) */
  minParticipation: 500_000,
  /** 1 hour minimum voting duration */
  minDuration: 3600n,
  /** 1 token (1e18) required to create proposals */
  minProposerVotingPower: 10n ** 18n,
} as const;

/**
 * Initial token amount minted to holder (1 token = 1e18 wei).
 */
export const INITIAL_TOKEN_AMOUNT = 10n ** 18n;

/**
 * DAO ownership token supply slider bounds, expressed in whole tokens.
 *
 * The UI mints whole-token supplies only; contract arguments use 18-decimal base
 * units derived by parseDaoTokenSupplyUnits().
 */
export const DAO_TOKEN_SUPPLY_MIN_WHOLE = 1_000;
export const DAO_TOKEN_SUPPLY_MAX_WHOLE = 1_000_000_000;
export const DAO_TOKEN_SUPPLY_DEFAULT_WHOLE = 1_000_000;

/**
 * Zero address used for "deploy new token" in TokenSettings.
 */
export const DEPLOY_NEW_TOKEN_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;
