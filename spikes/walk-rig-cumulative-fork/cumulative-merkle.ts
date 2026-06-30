// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
//
// 1inch CumulativeMerkleDrop-compatible merkle tree helper.
//
// Leaf format (matches the vendored 1inch CumulativeMerkleDrop, see
// packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts):
//
//   element = abi.encodePacked(address account, uint256 cumulativeAmount)
//           = 20-byte address ++ 32-byte big-endian amount   (52 bytes)
//   leaf    = keccak256(element)
//
// Tree: keccak256 of SORTED sibling pairs (OpenZeppelin MerkleProof-compatible,
// i.e. `{ hashLeaves: true, sortPairs: true }` in merkletreejs terms — which is
// exactly what 1inch's own tests use). Proof = the sequence of sibling hashes
// from leaf up to root.
//
// Implemented inline (no merkletreejs dependency) using viem's keccak256 +
// encodePacked so it resolves through the same import chain as the harness.

import { type Hex, encodePacked, keccak256 } from "viem";

export type CumulativeAllocation = {
  account: `0x${string}`;
  cumulativeAmount: bigint;
};

export type CumulativeLeaf = {
  account: `0x${string}`;
  cumulativeAmount: bigint;
  leafHash: Hex;
  proof: Hex[];
};

export type CumulativeTree = {
  root: Hex;
  leaves: CumulativeLeaf[];
};

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
  // concat the two 32-byte words and hash
  return keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as Hex);
}

/**
 * Build a cumulative merkle tree (sorted-pair, OZ/1inch-compatible) and produce
 * a per-leaf proof for every allocation.
 */
export function buildCumulativeTree(
  allocations: CumulativeAllocation[]
): CumulativeTree {
  if (allocations.length === 0) {
    throw new Error("buildCumulativeTree: need at least one allocation");
  }

  // Leaf hashes (dedupe-free; 1inch sorts the leaf layer too via sortPairs, but
  // we keep the original index→leaf mapping so we can emit proofs per account).
  const leafHashes: Hex[] = allocations.map((a) =>
    hashCumulativeLeaf(a.account, a.cumulativeAmount)
  );

  // merkletreejs with sortLeaves:false (default) but sortPairs:true — only pairs
  // are sorted, not the leaf layer. We build the tree layer-by-layer, tracking
  // each leaf's path so we can collect its sibling hashes (the proof).
  let layer: Hex[] = [...leafHashes];
  // proofPaths[i] accumulates the sibling hashes for original leaf i.
  const positions: number[] = allocations.map((_, i) => i);
  const proofs: Hex[][] = allocations.map(() => []);

  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : undefined;
      if (right === undefined) {
        // odd node promoted unchanged (merkletreejs default behavior)
        next.push(left);
      } else {
        next.push(hashPairSorted(left, right));
      }
      // record sibling for any tracked leaf sitting in this pair
      for (let p = 0; p < positions.length; p++) {
        const pos = positions[p];
        if (pos === i && right !== undefined) {
          proofs[p].push(right);
        } else if (pos === i + 1) {
          proofs[p].push(left);
        }
      }
    }
    // update positions to parent index
    for (let p = 0; p < positions.length; p++) {
      positions[p] = Math.floor(positions[p] / 2);
    }
    layer = next;
  }

  const root = layer[0];
  const leaves: CumulativeLeaf[] = allocations.map((a, i) => ({
    account: a.account,
    cumulativeAmount: a.cumulativeAmount,
    leafHash: leafHashes[i],
    proof: proofs[i],
  }));

  return { root, leaves };
}

/** Local off-chain verify mirroring OZ MerkleProof.verify (sorted pairs). */
export function verifyCumulativeProof(
  leaf: Hex,
  proof: Hex[],
  root: Hex
): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashPairSorted(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}
