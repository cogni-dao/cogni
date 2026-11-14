// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/osx/events`
 * Purpose: Aragon OSx event ABIs and topic constants for receipt decoding.
 * Scope: Pure constants; does not make RPC calls.
 * Invariants: Topics computed from keccak256 of canonical signatures.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

/**
 * DAORegistered event emitted by DAORegistry when a DAO is registered.
 * Signature: DAORegistered(address indexed dao, address indexed creator, string subdomain)
 */
export const DAO_REGISTERED_EVENT = {
  abi: {
    type: "event",
    name: "DAORegistered",
    inputs: [
      { name: "dao", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "subdomain", type: "string", indexed: false },
    ],
  },
  // keccak256("DAORegistered(address,address,string)")
  // Verified with: cast keccak "DAORegistered(address,address,string)"
  topic:
    "0xbc0b11fe649bb4d67c7fb40936163e5423f45c3ae83fbd8f8f8c75e1a3fa97af" as const,
} as const;

/**
 * InstallationApplied event emitted by PluginSetupProcessor when a plugin is installed.
 * Signature: InstallationApplied(address indexed dao, address indexed plugin, bytes32 preparedSetupId, bytes32 appliedSetupId)
 */
export const INSTALLATION_APPLIED_EVENT = {
  abi: {
    type: "event",
    name: "InstallationApplied",
    inputs: [
      { name: "dao", type: "address", indexed: true },
      { name: "plugin", type: "address", indexed: true },
      { name: "preparedSetupId", type: "bytes32", indexed: false },
      { name: "appliedSetupId", type: "bytes32", indexed: false },
    ],
  },
  // keccak256("InstallationApplied(address,address,bytes32,bytes32)")
  // Verified with: cast keccak "InstallationApplied(address,address,bytes32,bytes32)"
  topic:
    "0x74e616c7264536b98a5ec234d051ae6ce1305bf05c85f9ddc112364440ccf129" as const,
} as const;

/**
 * All OSx events as array for use with viem decodeEventLog.
 */
export const OSX_EVENT_ABIS = [
  DAO_REGISTERED_EVENT.abi,
  INSTALLATION_APPLIED_EVENT.abi,
] as const;
