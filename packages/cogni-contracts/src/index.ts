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
// 1inch CumulativeMerkleDrop (vendored, not authored) — ONE per node, mutable
// owner-set root + cumulative claim; replaces per-epoch Uniswap v1 deploys.
export {
  CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
  CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE,
} from "./cumulative-merkle-distributor";
// Uniswap MerkleDistributor v1 (vendored, not authored)
export {
  MERKLE_DISTRIBUTOR_ABI,
  MERKLE_DISTRIBUTOR_BYTECODE,
} from "./merkle-distributor";
