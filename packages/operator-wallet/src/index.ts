// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet`
 * Purpose: Operator wallet capability package — port, domain policy, and types for on-chain payment operations.
 * Scope: Exports port interface, split allocation math, and domain constants. Does not export Privy adapter (use subpath `@cogni/operator-wallet/adapters/privy`).
 * Invariants: NO_SRC_IMPORTS, NO_SERVICE_IMPORTS, PURE_LIBRARY.
 * Side-effects: none
 * Links: docs/spec/operator-wallet.md
 * @public
 */

export {
  calculateSplitAllocations,
  MINIMUM_PAYMENT_USD,
  numberToPpm,
  OPENROUTER_CRYPTO_FEE_PPM,
  PPM,
  SPLIT_TOTAL_ALLOCATION,
} from "./domain/split-allocation.js";
export {
  BASE_CHAIN_ID,
  buildX402Domain,
  buildX402TypedData,
  TRANSFER_WITH_AUTHORIZATION,
  USDC_ADDRESS,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  X402_EIP712_TYPES,
  type X402TypedData,
} from "./domain/x402-eip3009.js";
export type {
  OperatorWalletPort,
  X402PaymentParams,
} from "./port/operator-wallet.port.js";
