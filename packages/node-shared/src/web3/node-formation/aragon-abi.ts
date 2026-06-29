// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/web3/aragon-abi`
 * Purpose: Minimal Aragon OSx ABIs needed for Node Formation P0.
 * Scope: ABI constants only; does not include full Aragon interfaces.
 * Invariants: Keep minimal surface; do not add unrelated functions/events.
 * Side-effects: none
 * Links: docs/spec/node-formation.md
 * @public
 */

/**
 * DAOFactory minimal ABI (createDao).
 *
 * CRITICAL: Struct field order must match OSx v1.4.0 exactly.
 * Source: https://github.com/aragon/osx/tree/v1.4.0/packages/contracts/src/framework/dao/DAOFactory.sol
 *
 * DAOSettings field order: trustedForwarder, daoURI, subdomain, metadata
 * PluginSetupRef field order: versionTag, pluginSetupRepo
 */
export const DAO_FACTORY_ABI = [
  {
    type: "function",
    name: "pluginSetupProcessor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "createDao",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_daoSettings",
        type: "tuple",
        components: [
          // Order: trustedForwarder, daoURI, subdomain, metadata
          { name: "trustedForwarder", type: "address" },
          { name: "daoURI", type: "string" },
          { name: "subdomain", type: "string" },
          { name: "metadata", type: "bytes" },
        ],
      },
      {
        name: "_pluginSettings",
        type: "tuple[]",
        components: [
          {
            name: "pluginSetupRef",
            type: "tuple",
            components: [
              // Order: versionTag BEFORE pluginSetupRepo
              {
                name: "versionTag",
                type: "tuple",
                components: [
                  { name: "release", type: "uint8" },
                  { name: "build", type: "uint16" },
                ],
              },
              { name: "pluginSetupRepo", type: "address" },
            ],
          },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "createdDao", type: "address" },
      {
        name: "installedPlugins",
        type: "tuple[]",
        components: [
          { name: "plugin", type: "address" },
          {
            name: "preparedSetupData",
            type: "tuple",
            components: [
              { name: "helpers", type: "address[]" },
              {
                name: "permissions",
                type: "tuple[]",
                components: [
                  { name: "operation", type: "uint8" },
                  { name: "where", type: "address" },
                  { name: "who", type: "address" },
                  { name: "condition", type: "address" },
                  { name: "permissionId", type: "bytes32" },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
] as const;

/** TokenVoting minimal ABI. */
export const TOKEN_VOTING_ABI = [
  {
    type: "function",
    name: "getVotingToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "token", type: "address" }],
  },
] as const;

/** GovernanceERC20 minimal ABI. */
export const GOVERNANCE_ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
