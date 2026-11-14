// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/cogni-contracts`
 * Purpose: Cogni-owned smart contract artifacts (ABI, bytecode, types).
 * Scope: Constants only; does not include addresses, tx builders, or RPC logic.
 * Invariants: No runtime dependencies; pure constants.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @public
 */

// CogniSignal
export { COGNI_SIGNAL_ABI, COGNI_SIGNAL_BYTECODE } from "./cogni-signal";
// 1inch CumulativeMerkleDrop (vendored, not authored) — ONE per node, mutable
// owner-set root + cumulative claim; the R4 claim UI reads this ABI.
export {
  CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
  CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE,
} from "./cumulative-merkle-distributor";
// DistributionPublishCondition (Cogni-authored) — scoped Aragon OSx IPermissionCondition;
// deployed once per node, then bound via grantWithCondition so the executor's EXECUTE grant
// only permits the [mint, setMerkleRoot] publish action set (story.5005).
export {
  DISTRIBUTION_PUBLISH_CONDITION_ABI,
  DISTRIBUTION_PUBLISH_CONDITION_BYTECODE,
} from "./distribution-publish-condition";
