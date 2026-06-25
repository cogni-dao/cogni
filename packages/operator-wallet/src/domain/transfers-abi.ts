// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/domain/transfers-abi`
 * Purpose: ABI constants for Coinbase Commerce Onchain Payment Protocol and ERC-20 approve.
 * Scope: Typed ABI arrays for viem encodeFunctionData. Does not perform I/O.
 * Invariants: ABIs match deployed contract interfaces on Base mainnet.
 * Side-effects: none
 * Links: https://github.com/coinbase/commerce-onchain-payment-protocol
 * @internal
 */

/**
 * Coinbase Commerce Transfers contract ABI — transferTokenPreApproved only.
 * Source: Transfers.sol (commerce-onchain-payment-protocol)
 * Validated by spike.0090 on Base mainnet (2026-03-09).
 */
export const TRANSFERS_ABI = [
  {
    type: "function",
    name: "transferTokenPreApproved",
    inputs: [
      {
        name: "_intent",
        type: "tuple",
        components: [
          { name: "recipientAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "recipientCurrency", type: "address" },
          { name: "refundDestination", type: "address" },
          { name: "feeAmount", type: "uint256" },
          { name: "id", type: "bytes16" },
          { name: "operator", type: "address" },
          { name: "signature", type: "bytes" },
          { name: "prefix", type: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Minimal ERC-20 ABI — approve only.
 * Used for USDC approval to the Transfers contract before transferTokenPreApproved.
 */
export const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Minimal ERC-20 ABI — transfer only.
 * Used by withdrawToSteward to move USDC from the operator wallet to the
 * config-pinned steward wallet (a plain transfer, not a contract checkout).
 */
export const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
