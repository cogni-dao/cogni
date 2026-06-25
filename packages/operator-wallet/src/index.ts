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
export type { OperatorWalletPort } from "./port/operator-wallet.port.js";
