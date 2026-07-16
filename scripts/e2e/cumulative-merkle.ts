// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `scripts/e2e/cumulative-merkle`
 * Purpose: 1inch CumulativeMerkleDrop-compatible leaf hash + proof verifier — used by the finalize→mint→claim harness to independently re-verify the REAL persisted manifest's proofs against its root before spending gas on-chain.
 * Scope: Pure functions (keccak256 leaf + sorted-pair proof verify). Does NOT build trees — the R3 distribution service is the authoritative builder; this only checks what it persisted. No network I/O, no secrets.
 * Invariants:
 * - LEAF_FORMAT: leaf = keccak256(abi.encodePacked(address account, uint256 cumulativeAmount)) — byte-identical to the vendored 1inch CumulativeMerkleDrop.
 * - SORTED_PAIR_PROOF: proof folds via keccak256 of ascending-ordered sibling pairs (OpenZeppelin MerkleProof-compatible).
 * Side-effects: none
 * Links: packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts, spikes/walk-rig-cumulative-fork/cumulative-merkle.ts
 * @public
 */

import { encodePacked, type Hex, keccak256 } from "viem";

/** leaf = keccak256(abi.encodePacked(address account, uint256 cumulativeAmount)) */
export function hashCumulativeLeaf(
  account: `0x${string}`,
  cumulativeAmount: bigint
): Hex {
  // The contract packs the raw 20 address bytes; checksum casing is irrelevant
  // on-chain. Lowercase so viem's encodePacked doesn't reject a non-EIP-55
  // literal (byte-identical to the checksummed form).
  return keccak256(
    encodePacked(
      ["address", "uint256"],
      [account.toLowerCase() as `0x${string}`, cumulativeAmount]
    )
  );
}

/** keccak256 of the two children in ASCENDING byte order (OZ-compatible). */
function hashPairSorted(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as Hex);
}

/** Off-chain verify mirroring OZ MerkleProof.verify (sorted pairs). */
export function verifyCumulativeProof(
  leaf: Hex,
  proof: readonly Hex[],
  root: Hex
): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashPairSorted(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}
