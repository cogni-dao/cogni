// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/cogni-contracts`
 * Purpose: Smart contract artifacts (ABI, bytecode, types) — Cogni-owned and vendored OSS.
 * Scope: Constants only; does not include addresses, tx builders, or RPC logic.
 * Invariants: No runtime dependencies; pure constants.
 * Side-effects: none
 * Links: docs/spec/packages-architecture.md
 * @public
 */

// CogniSignal
export { COGNI_SIGNAL_ABI, COGNI_SIGNAL_BYTECODE } from "./cogni-signal";

// Uniswap MerkleDistributor v1 (vendored, not authored)
export {
  MERKLE_DISTRIBUTOR_ABI,
  MERKLE_DISTRIBUTOR_BYTECODE,
} from "./merkle-distributor";
