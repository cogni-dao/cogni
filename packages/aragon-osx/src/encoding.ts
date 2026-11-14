// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/encoding`
 * Purpose: ABI-encode Aragon TokenVoting setup data for Node Formation P0.
 * Scope: Pure encoding only; does not make RPC calls.
 * Invariants: Encoded layout must match OSx TokenVoting setup contract.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

import { encodeAbiParameters, parseAbiParameters } from "viem";

import type { Hex, HexAddress } from "./types";

export type TokenVotingVotingSettings = {
  votingMode: number; // uint8
  supportThreshold: number; // uint32
  minParticipation: number; // uint32
  minDuration: bigint; // uint64
  minProposerVotingPower: bigint; // uint256
};

export type TokenVotingTokenSettings = {
  addr: HexAddress; // address (0x0 => deploy new token in Aragon setup)
  name: string;
  symbol: string;
};

export type TokenVotingMintSettingsV1_3 = {
  receivers: readonly HexAddress[];
  amounts: readonly bigint[];
};

export type TokenVotingMintSettingsV1_4 = TokenVotingMintSettingsV1_3 & {
  ensureDelegationOnMint: boolean;
};

export type TokenVotingTargetConfig = {
  target: HexAddress;
  operation: number; // uint8
};

export function encodeTokenVotingSetup(params: {
  votingSettings: TokenVotingVotingSettings;
  tokenSettings: TokenVotingTokenSettings;
  mintSettings: TokenVotingMintSettingsV1_3 | TokenVotingMintSettingsV1_4;
  targetConfig: TokenVotingTargetConfig;
  minApprovals: bigint;
  pluginMetadata: Hex;
  excludedAccounts: readonly HexAddress[];
  /**
   * Controls MintSettings encoding shape.
   * - "v1.4": (receivers, amounts, ensureDelegationOnMint)
   * - "v1.3": (receivers, amounts)
   *
   * IMPORTANT: Must match the deployed TokenVoting setup ABI for your chain.
   */
  mintSettingsVersion: "v1.4" | "v1.3";
}): Hex {
  // Layout based on NODE_FORMATION_SPEC.md:
  // (
  //   VotingSettings,
  //   TokenSettings,
  //   MintSettings,
  //   TargetConfig,
  //   uint256 minApprovals,
  //   bytes pluginMetadata,
  //   address[] excludedAccounts
  // )
  const mintSettingsAbi =
    params.mintSettingsVersion === "v1.4"
      ? "(address[] receivers,uint256[] amounts,bool ensureDelegationOnMint) mintSettings,"
      : "(address[] receivers,uint256[] amounts) mintSettings,";

  const abi = parseAbiParameters(
    "(uint8 votingMode,uint32 supportThreshold,uint32 minParticipation,uint64 minDuration,uint256 minProposerVotingPower) votingSettings," +
      "(address addr,string name,string symbol) tokenSettings," +
      mintSettingsAbi +
      "(address target,uint8 operation) targetConfig," +
      "uint256 minApprovals," +
      "bytes pluginMetadata," +
      "address[] excludedAccounts"
  );

  const mintSettings =
    params.mintSettingsVersion === "v1.4"
      ? {
          receivers: [...params.mintSettings.receivers],
          amounts: [...params.mintSettings.amounts],
          ensureDelegationOnMint:
            "ensureDelegationOnMint" in params.mintSettings
              ? params.mintSettings.ensureDelegationOnMint
              : false,
        }
      : {
          receivers: [...params.mintSettings.receivers],
          amounts: [...params.mintSettings.amounts],
        };

  return encodeAbiParameters(abi, [
    {
      votingMode: params.votingSettings.votingMode,
      supportThreshold: params.votingSettings.supportThreshold,
      minParticipation: params.votingSettings.minParticipation,
      minDuration: params.votingSettings.minDuration,
      minProposerVotingPower: params.votingSettings.minProposerVotingPower,
    },
    {
      addr: params.tokenSettings.addr,
      name: params.tokenSettings.name,
      symbol: params.tokenSettings.symbol,
    },
    mintSettings,
    {
      target: params.targetConfig.target,
      operation: params.targetConfig.operation,
    },
    params.minApprovals,
    params.pluginMetadata,
    [...params.excludedAccounts],
  ]);
}
