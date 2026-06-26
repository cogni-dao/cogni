// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/domain/transfers-abi`
 * Purpose: Minimal ERC-20 ABI constants for viem encodeFunctionData.
 * Scope: Typed ABI arrays for viem encodeFunctionData. Does not perform I/O.
 * Invariants: ABIs match deployed contract interfaces on Base mainnet.
 * Side-effects: none
 * Links: privy-operator-wallet.adapter.ts, docs/spec/operator-wallet.md
 * @internal
 */

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
