// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/contracts/distribution-publish-condition/abi`
 * Purpose: ABI for the Cogni-authored scoped `DistributionPublishCondition` contract.
 *   The Aragon OSx `IPermissionCondition` restricts a node executor's EXECUTE grant to
 *   the publish action set only.
 * Scope: ABI constant only; does not include bytecode or addresses.
 * Invariants: ABI must match the compiled artifact from
 *   `src/distribution-publish-condition/DistributionPublishCondition.sol` at the pinned
 *   compiler settings (see bytecode.ts provenance).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/distribution-lifecycle
 * @public
 */

/**
 * `DistributionPublishCondition` ABI.
 *
 * AUTHORED by Cogni (unlike the vendored 1inch distributor). The contract extends
 * Aragon's `PermissionCondition` abstract base (osx-commons-contracts 1.4.0), the
 * best-practice way to author an OSx condition. Because the base derives from
 * `ERC165`, the ABI includes `supportsInterface(bytes4)` and `protocolVersion()` in
 * ADDITION to `isGranted` + the two immutables — and
 * `supportsInterface(type(IPermissionCondition).interfaceId)` (interfaceId
 * `0x2675fdd0` == `isGranted` selector) returns true, which is exactly the ERC-165
 * check `PermissionManager.grantWithCondition` performs before accepting the condition.
 * (The previous hand-rolled version omitted `supportsInterface` and reverted
 * `grantWithCondition` with `ConditionInterfaceNotSupported` / `0xa6a7dbbd`.)
 *
 * `isGranted` decodes the `DAO.execute` calldata and returns true ONLY when `_callId`
 * equals the distributor's live root, the failure bitmap is zero, and the action set is
 * exactly `[token.mint(distributor, *), distributor.setMerkleRoot(newRoot)]` — nothing
 * else, no third action, no other target. Two immutables set at deploy:
 * `constructor(address token, address distributor)`.
 *
 * Source:    packages/cogni-contracts/src/distribution-publish-condition/
 *              DistributionPublishCondition.sol
 * Compiler:  solc 0.8.17+commit.8df45f5f, optimizer enabled (200 runs), standard-JSON.
 * Deps:      @aragon/osx-commons-contracts@1.4.0 (PermissionCondition, IPermissionCondition,
 *              Action from executors/IExecutor.sol) + its @openzeppelin/contracts peer (ERC165).
 *
 * Constructor: (address _token, address _distributor) — both immutable.
 */
export const DISTRIBUTION_PUBLISH_CONDITION_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "_token", type: "address", internalType: "address" },
      { name: "_distributor", type: "address", internalType: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "distributor",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isGranted",
    inputs: [
      { name: "", type: "address", internalType: "address" },
      { name: "", type: "address", internalType: "address" },
      { name: "", type: "bytes32", internalType: "bytes32" },
      { name: "_data", type: "bytes", internalType: "bytes" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "protocolVersion",
    inputs: [],
    outputs: [{ name: "", type: "uint8[3]", internalType: "uint8[3]" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "supportsInterface",
    inputs: [{ name: "_interfaceId", type: "bytes4", internalType: "bytes4" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "token",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
] as const;
