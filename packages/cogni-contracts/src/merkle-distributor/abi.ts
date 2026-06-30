// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/contracts/merkle-distributor/abi`
 * Purpose: Stock Uniswap MerkleDistributor v1 ABI for deployment and verification.
 * Scope: ABI constant only; does not include bytecode or addresses.
 * Invariants: ABI must match the published @uniswap/merkle-distributor@1.0.1 artifact.
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md
 * @public
 */

/**
 * Uniswap MerkleDistributor v1 ABI.
 *
 * VENDORED, NOT AUTHORED. This is the canonical, unmodified Uniswap
 * MerkleDistributor — Cogni ships no bespoke claim contract.
 *
 * Source:    npm `@uniswap/merkle-distributor@1.0.1`
 *            (tarball sha1 dc3d911f65a860fc3f0cae074bdcd08ed6a27a4d, verified)
 *            build/MerkleDistributor.json `.abi`
 * Repo:      github.com/Uniswap/merkle-distributor
 *            contracts/MerkleDistributor.sol
 * Commit:    0d478d722da2e5d95b7292fd8cbdb363d98e9a93 (npm `gitHead`)
 * License:   GPL-3.0-or-later (Uniswap/merkle-distributor repo LICENSE)
 *
 * Constructor: (address token_, bytes32 merkleRoot_)
 * Leaf:        keccak256(abi.encodePacked(uint256 index, address account, uint256 amount))
 */
export const MERKLE_DISTRIBUTOR_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "token_", type: "address", internalType: "address" },
      { name: "merkleRoot_", type: "bytes32", internalType: "bytes32" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Claimed",
    anonymous: false,
    inputs: [
      {
        name: "index",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "account",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "claim",
    inputs: [
      { name: "index", type: "uint256", internalType: "uint256" },
      { name: "account", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
      { name: "merkleProof", type: "bytes32[]", internalType: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isClaimed",
    inputs: [{ name: "index", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "merkleRoot",
    inputs: [],
    outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
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
