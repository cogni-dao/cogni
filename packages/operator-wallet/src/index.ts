// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet`
 * Purpose: Operator wallet capability package — ports, domain policy, and types for on-chain payment operations and Cosmos-chain signing.
 * Scope: Exports port interfaces, split allocation math, Cosmos signature/address helpers, and domain constants. Does not export adapters (use subpaths `@cogni/operator-wallet/adapters/privy` and `@cogni/operator-wallet/adapters/cosmjs`).
 * Invariants: NO_SRC_IMPORTS, NO_SERVICE_IMPORTS, PURE_LIBRARY.
 * Side-effects: none
 * Links: docs/spec/operator-wallet.md
 * @public
 */

export {
  DEFAULT_BECH32_PREFIX,
  deriveCosmosAddress,
} from "./domain/cosmos-address.js";
export {
  derToFixed64,
  normalizeToLowS,
  parseCompressedPubkeyHex,
  toFixed64LowS,
} from "./domain/secp256k1-signature.js";
export {
  calculateSplitAllocations,
  MINIMUM_PAYMENT_USD,
  numberToPpm,
  OPENROUTER_CRYPTO_FEE_PPM,
  PPM,
  SPLIT_TOTAL_ALLOCATION,
} from "./domain/split-allocation.js";
export {
  CosmosSignerError,
  type CosmosSignerPort,
  InvalidDigestError,
  isCosmosSignerError,
  SignatureFormatError,
  SignerRequestError,
} from "./port/cosmos-signer.port.js";
export type {
  OperatorWalletPort,
  StewardWithdrawal,
} from "./port/operator-wallet.port.js";
