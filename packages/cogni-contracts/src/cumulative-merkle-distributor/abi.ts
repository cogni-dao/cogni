// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/contracts/cumulative-merkle-distributor/abi`
 * Purpose: Stock 1inch CumulativeMerkleDrop ABI for deployment and verification.
 * Scope: ABI constant only; does not include bytecode or addresses.
 * Invariants: ABI must match the compiled 1inch CumulativeMerkleDrop artifact at
 *   the pinned commit (see provenance below).
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md
 * @public
 */

/**
 * 1inch CumulativeMerkleDrop ABI.
 *
 * VENDORED, NOT AUTHORED. This is the canonical, unmodified 1inch
 * CumulativeMerkleDrop — the top-pattern recurring-reward distributor
 * (sibling of Hop / Across). Cogni ships no bespoke claim contract.
 *
 * Why this and not Uniswap MerkleDistributor v1: the Uniswap artifact is a
 * one-shot airdrop with an IMMUTABLE root — claiming a NEW epoch requires
 * deploying a NEW contract (~550k gas, N contracts/node). CumulativeMerkleDrop
 * has a MUTABLE owner-set root and CUMULATIVE leaves, so ONE distributor per
 * node serves every epoch: per epoch you `setMerkleRoot(newCumulativeRoot)` and
 * mint only the delta. `claim` transfers `cumulativeAmount - cumulativeClaimed`.
 *
 * Source:    github.com/1inch/merkle-distribution
 *            contracts/CumulativeMerkleDrop.sol
 *            contracts/interfaces/ICumulativeMerkleDrop.sol
 * Commit:    3db322cac67449d4c58e429e194b460e8c6dca04
 *            (CumulativeMerkleDrop.sol last touched in this commit; repo HEAD)
 * License:   MIT (1inch/merkle-distribution LICENSE.md, © 2021 1inch)
 * Compiler:  solc 0.8.23+commit.f704f362, optimizer enabled (1,000,000 runs),
 *            evmVersion shanghai — the repo's own hardhat.config.ts settings.
 * Deps:      @openzeppelin/contracts@5.4.0 (Ownable, IERC20, Context),
 *            @1inch/solidity-utils@6.7.0 (SafeERC20).
 *
 * Constructor: (address token_)  — owner is set to msg.sender (Ownable);
 *              transfer ownership to the DAO so DAO governance owns setMerkleRoot.
 * Leaf:        keccak256(abi.encodePacked(address account, uint256 cumulativeAmount))
 *              — NO index (differs from Uniswap v1's (index, account, amount)).
 *              Proof verification uses SORTED sibling pairs (OZ-compatible).
 */
export const CUMULATIVE_MERKLE_DISTRIBUTOR_ABI = [
  {
    type: "constructor",
    inputs: [{ name: "token_", type: "address", internalType: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "token",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
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
    name: "cumulativeClaimed",
    inputs: [{ name: "", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setMerkleRoot",
    inputs: [{ name: "merkleRoot_", type: "bytes32", internalType: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claim",
    inputs: [
      { name: "account", type: "address", internalType: "address" },
      { name: "cumulativeAmount", type: "uint256", internalType: "uint256" },
      {
        name: "expectedMerkleRoot",
        type: "bytes32",
        internalType: "bytes32",
      },
      { name: "merkleProof", type: "bytes32[]", internalType: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [{ name: "newOwner", type: "address", internalType: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Claimed",
    anonymous: false,
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
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
    type: "event",
    name: "MerkelRootUpdated",
    anonymous: false,
    inputs: [
      {
        name: "oldMerkleRoot",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "newMerkleRoot",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
    ],
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    anonymous: false,
    inputs: [
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidProof",
    inputs: [],
  },
  {
    type: "error",
    name: "NothingToClaim",
    inputs: [],
  },
  {
    type: "error",
    name: "MerkleRootWasUpdated",
    inputs: [],
  },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [{ name: "owner", type: "address", internalType: "address" }],
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [{ name: "account", type: "address", internalType: "address" }],
  },
  {
    type: "error",
    name: "SafeTransferFailed",
    inputs: [],
  },
] as const;
