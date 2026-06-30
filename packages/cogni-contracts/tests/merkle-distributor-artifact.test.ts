// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/cogni-contracts/tests/merkle-distributor-artifact`
 * Purpose: Gate the vendored Uniswap MerkleDistributor v1 artifact — assert the
 *   ABI exposes the canonical claim interface and that OUR distribution leaf
 *   encoding is exactly what this distributor's `claim` verifies against.
 * Scope: Integrity + leaf-format conformance only; no on-chain behavior.
 * Invariants:
 *   - ABI selectors match keccak256 of the canonical Solidity signatures.
 *   - hashDaoTokenClaimLeaf == keccak256(abi.encodePacked(uint256,address,uint256)),
 *     which is byte-identical to the Uniswap MerkleDistributor leaf preimage.
 * Side-effects: none
 * Links: packages/cogni-contracts/src/merkle-distributor/abi.ts,
 *   packages/aragon-osx/src/token-distribution.ts
 * @public
 */

// hashDaoTokenClaimLeaf is re-exported by the @cogni/aragon-osx barrel from
// packages/aragon-osx/src/token-distribution.ts (frozen — imported, not touched).
import { hashDaoTokenClaimLeaf } from "@cogni/aragon-osx";
import { MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
import { encodePacked, keccak256, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

type AbiFn = {
  type: string;
  name?: string;
  inputs?: readonly { name?: string; type: string }[];
  outputs?: readonly { name?: string; type: string }[];
  stateMutability?: string;
};

function fn(name: string): AbiFn {
  const found = (MERKLE_DISTRIBUTOR_ABI as readonly AbiFn[]).find(
    (entry) => entry.type === "function" && entry.name === name
  );
  if (!found) {
    throw new Error(`ABI missing function ${name}`);
  }
  return found;
}

function signature(entry: AbiFn): string {
  const params = (entry.inputs ?? []).map((input) => input.type).join(",");
  return `${entry.name}(${params})`;
}

describe("MerkleDistributor ABI integrity", () => {
  it("exposes claim with the canonical Uniswap signature", () => {
    const claim = fn("claim");
    expect(claim.stateMutability).toBe("nonpayable");
    expect(signature(claim)).toBe(
      "claim(uint256,address,uint256,bytes32[])"
    );
    expect(claim.inputs?.map((i) => i.name)).toEqual([
      "index",
      "account",
      "amount",
      "merkleProof",
    ]);
    // claim(uint256,address,uint256,bytes32[]) selector = 0x2e7ba6ef
    expect(toFunctionSelector(signature(claim))).toBe("0x2e7ba6ef");
  });

  it("exposes isClaimed(uint256) returning bool", () => {
    const isClaimed = fn("isClaimed");
    expect(isClaimed.stateMutability).toBe("view");
    expect(signature(isClaimed)).toBe("isClaimed(uint256)");
    expect(isClaimed.outputs?.[0]?.type).toBe("bool");
    expect(toFunctionSelector("isClaimed(uint256)")).toBe("0x9e34070f");
  });

  it("exposes token() returning address", () => {
    const token = fn("token");
    expect(token.stateMutability).toBe("view");
    expect(signature(token)).toBe("token()");
    expect(token.outputs?.[0]?.type).toBe("address");
    expect(toFunctionSelector("token()")).toBe("0xfc0c546a");
  });

  it("exposes merkleRoot() returning bytes32", () => {
    const merkleRoot = fn("merkleRoot");
    expect(merkleRoot.stateMutability).toBe("view");
    expect(signature(merkleRoot)).toBe("merkleRoot()");
    expect(merkleRoot.outputs?.[0]?.type).toBe("bytes32");
    expect(toFunctionSelector("merkleRoot()")).toBe("0x2eb4a7ab");
  });

  it("constructor takes (address token_, bytes32 merkleRoot_)", () => {
    const ctor = (MERKLE_DISTRIBUTOR_ABI as readonly AbiFn[]).find(
      (entry) => entry.type === "constructor"
    );
    expect(ctor).toBeDefined();
    expect(ctor?.inputs?.map((i) => i.type)).toEqual(["address", "bytes32"]);
  });
});

describe("Leaf-format conformance (our encoding == Uniswap claim verification)", () => {
  /**
   * The Uniswap MerkleDistributor `claim` recomputes each leaf as:
   *   bytes32 node = keccak256(abi.encodePacked(index, account, amount));
   * where (index: uint256, account: address, amount: uint256). See
   * Uniswap/merkle-distributor@0d478d7 contracts/MerkleDistributor.sol.
   *
   * Our distribution-builder leaf (hashDaoTokenClaimLeaf, frozen in
   * packages/aragon-osx/src/token-distribution.ts) encodes the SAME preimage:
   *   keccak256(abi.encodePacked(uint256 index, address account, uint256 amount)).
   *
   * This test pins a fixed (index, account, amount) vector and asserts the two
   * encodings produce the identical 32-byte leaf, proving our manifests can be
   * claimed by the vendored stock distributor without a bespoke contract.
   */
  it("hashDaoTokenClaimLeaf matches the Uniswap leaf preimage for a fixed vector", () => {
    const index = 7;
    const account = "0x1111111111111111111111111111111111111111" as const;
    const amount = 123_456_789_000_000_000_000n; // 123.456789 tokens (1e18)

    // What our frozen distribution builder writes as the merkle leaf.
    const ours = hashDaoTokenClaimLeaf(index, account, amount);

    // What the Uniswap MerkleDistributor.claim recomputes on-chain.
    const uniswapLeaf = keccak256(
      encodePacked(
        ["uint256", "address", "uint256"],
        [BigInt(index), account, amount]
      )
    );

    expect(ours).toBe(uniswapLeaf);
    // Sanity: a real 32-byte hash, not an empty/zero default.
    expect(ours).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ours).not.toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
  });
});
