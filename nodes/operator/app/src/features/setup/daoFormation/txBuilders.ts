// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/setup/daoFormation/txBuilders`
 * Purpose: Pure functions to build transaction arguments for DAO formation.
 * Scope: Argument construction only; does not perform RPC calls or transaction signing.
 * Invariants: Uses pinned OSx version constants.
 * Side-effects: none
 * Links: docs/spec/node-formation.md
 * @public
 */

import {
  DEFAULT_VOTING_SETTINGS,
  DEPLOY_NEW_TOKEN_ADDRESS,
  encodeTokenVotingSetup,
  getAragonAddresses,
  type HexAddress,
  MINT_SETTINGS_VERSION,
  type SupportedChainId,
  TOKEN_VOTING_VERSION_TAG,
} from "@cogni/aragon-osx";
import { encodeAbiParameters, parseAbiParameters } from "viem";

import type { DAOFormationConfig } from "./formation.reducer";

// ============================================================================
// Types
// ============================================================================

/**
 * Type for createDao transaction args.
 *
 * CRITICAL: Struct field order must match OSx v1.4.0 exactly.
 * - DAOSettings: trustedForwarder, daoURI, subdomain, metadata
 * - PluginSetupRef: versionTag BEFORE pluginSetupRepo
 */
export interface CreateDaoTxArgs {
  address: HexAddress;
  args: readonly [
    daoSettings: {
      trustedForwarder: HexAddress;
      daoURI: string;
      subdomain: string;
      metadata: `0x${string}`;
    },
    pluginSettings: readonly [
      {
        pluginSetupRef: {
          versionTag: { release: number; build: number };
          pluginSetupRepo: HexAddress;
        };
        data: `0x${string}`;
      },
    ],
  ];
}

export interface DeploySignalTxArgs {
  args: readonly [daoAddress: HexAddress];
}

// ============================================================================
// Builders
// ============================================================================

/**
 * Build arguments for DAOFactory.createDao transaction.
 *
 * CRITICAL: This must produce args matching the OSx v1.4.0 createDao signature:
 *   createDao(DAOSettings, PluginSettings[])
 *
 * DAOSettings field order: trustedForwarder, daoURI, subdomain, metadata
 * PluginSetupRef field order: versionTag, pluginSetupRepo
 */
export function buildCreateDaoArgs(
  chainId: SupportedChainId,
  config: DAOFormationConfig
): CreateDaoTxArgs {
  const aragonAddresses = getAragonAddresses(chainId);

  // Encode TokenVoting setup data (7-param struct)
  const tokenVotingSetupData = encodeTokenVotingSetup({
    votingSettings: DEFAULT_VOTING_SETTINGS,
    tokenSettings: {
      addr: DEPLOY_NEW_TOKEN_ADDRESS,
      name: config.tokenName,
      symbol: config.tokenSymbol,
    },
    mintSettings: {
      receivers: [config.initialHolder],
      amounts: [config.genesisMintUnits],
    },
    targetConfig: {
      target: DEPLOY_NEW_TOKEN_ADDRESS,
      operation: 0,
    },
    minApprovals: 0n,
    pluginMetadata: "0x",
    excludedAccounts: [],
    mintSettingsVersion: MINT_SETTINGS_VERSION,
  });

  // Encode DAO metadata: matches Foundry's abi.encode(string(...))
  // The Foundry script encodes a human-readable name string
  const daoMetadata = encodeAbiParameters(parseAbiParameters("string"), [
    `CogniSignal DAO - ${config.tokenName}`,
  ]);

  return {
    address: aragonAddresses.daoFactory,
    args: [
      // DAOSettings: trustedForwarder, daoURI, subdomain, metadata
      {
        trustedForwarder: DEPLOY_NEW_TOKEN_ADDRESS,
        daoURI: "",
        subdomain: "", // No ENS subdomain
        metadata: daoMetadata,
      },
      // PluginSettings array
      [
        {
          pluginSetupRef: {
            // CRITICAL: versionTag BEFORE pluginSetupRepo
            versionTag: TOKEN_VOTING_VERSION_TAG,
            pluginSetupRepo: aragonAddresses.tokenVotingPluginRepo,
          },
          data: tokenVotingSetupData,
        },
      ],
    ] as const,
  };
}

/**
 * Build arguments for CogniSignal deployment.
 */
export function buildDeploySignalArgs(
  daoAddress: HexAddress
): DeploySignalTxArgs {
  return {
    args: [daoAddress] as const,
  };
}
