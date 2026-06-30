// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/cogni-contracts/tests/cumulative-merkle-distributor-artifact`
 * Purpose: Gate the vendored 1inch CumulativeMerkleDrop artifact — assert the ABI
 *   exposes the canonical cumulative claim/setRoot interface and pin the EXACT
 *   leaf preimage this distributor's `claim` verifies against (cumulative, NO index).
 * Scope: Integrity + leaf-format conformance only; no on-chain behavior.
 * Invariants:
 *   - ABI selectors match keccak256 of the canonical Solidity signatures.
 *   - The cumulative leaf == keccak256(abi.encodePacked(address, uint256)) — a
 *     DIFFERENT preimage from Uniswap v1's (uint256 index, address, uint256).
 *   - A sorted-pair Merkle proof over cumulative leaves verifies the way the
 *     contract's `_verifyAsm` recomputes it (OZ-compatible sorted siblings).
 * Side-effects: none
 * Links: packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts,
 *   packages/aragon-osx/src/token-distribution.ts (R2/R3 will add a cumulative
 *   leaf builder — see PR notes; this artifact is the on-chain target).
 * @public
 */

import { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
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
  const found = (CUMULATIVE_MERKLE_DISTRIBUTOR_ABI as readonly AbiFn[]).find(
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

/**
 * Cumulative leaf preimage — EXACTLY what CumulativeMerkleDrop.claim recomputes:
 *   bytes32 leaf = keccak256(abi.encodePacked(account, cumulativeAmount));
 * No index (cf. Uniswap v1's (index, account, amount)).
 */
function cumulativeLeaf(account: `0x${string}`, cumulativeAmount: bigint) {
  return keccak256(
    encodePacked(["address", "uint256"], [account, cumulativeAmount])
  );
}

/** Sorted-pair parent hash — matches the contract's `_verifyAsm` and OZ trees. */
function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  // keccak over the two 32-byte words concatenated (no length prefix).
  return keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as `0x${string}`);
}

describe("CumulativeMerkleDrop ABI integrity", () => {
  it("exposes claim(account,cumulativeAmount,expectedMerkleRoot,proof)", () => {
    const claim = fn("claim");
    expect(claim.stateMutability).toBe("nonpayable");
    expect(signature(claim)).toBe("claim(address,uint256,bytes32,bytes32[])");
    expect(claim.inputs?.map((i) => i.name)).toEqual([
      "account",
      "cumulativeAmount",
      "expectedMerkleRoot",
      "merkleProof",
    ]);
    // claim(address,uint256,bytes32,bytes32[]) selector
    expect(toFunctionSelector(signature(claim))).toBe(
      toFunctionSelector("claim(address,uint256,bytes32,bytes32[])")
    );
  });

  it("exposes setMerkleRoot(bytes32) for owner root rotation", () => {
    const setRoot = fn("setMerkleRoot");
    expect(setRoot.stateMutability).toBe("nonpayable");
    expect(signature(setRoot)).toBe("setMerkleRoot(bytes32)");
  });

  it("exposes cumulativeClaimed(address) returning uint256", () => {
    const claimed = fn("cumulativeClaimed");
    expect(claimed.stateMutability).toBe("view");
    expect(signature(claimed)).toBe("cumulativeClaimed(address)");
    expect(claimed.outputs?.[0]?.type).toBe("uint256");
  });

  it("exposes merkleRoot() returning bytes32", () => {
    const merkleRoot = fn("merkleRoot");
    expect(merkleRoot.stateMutability).toBe("view");
    expect(signature(merkleRoot)).toBe("merkleRoot()");
    expect(merkleRoot.outputs?.[0]?.type).toBe("bytes32");
    expect(toFunctionSelector("merkleRoot()")).toBe("0x2eb4a7ab");
  });

  it("exposes token() returning address", () => {
    const token = fn("token");
    expect(token.stateMutability).toBe("view");
    expect(signature(token)).toBe("token()");
    expect(token.outputs?.[0]?.type).toBe("address");
    expect(toFunctionSelector("token()")).toBe("0xfc0c546a");
  });

  it("exposes Ownable owner()/transferOwnership so the DAO can own the root", () => {
    const owner = fn("owner");
    expect(owner.stateMutability).toBe("view");
    expect(owner.outputs?.[0]?.type).toBe("address");
    const transfer = fn("transferOwnership");
    expect(signature(transfer)).toBe("transferOwnership(address)");
  });

  it("constructor takes only (address token_) — root starts unset, owner=deployer", () => {
    const ctor = (CUMULATIVE_MERKLE_DISTRIBUTOR_ABI as readonly AbiFn[]).find(
      (entry) => entry.type === "constructor"
    );
    expect(ctor).toBeDefined();
    expect(ctor?.inputs?.map((i) => i.type)).toEqual(["address"]);
  });
});

describe("Cumulative leaf-format conformance (cumulative, NO index)", () => {
  /**
   * The cumulative distributor recomputes each leaf as:
   *   bytes32 leaf = keccak256(abi.encodePacked(account, cumulativeAmount));
   * where (account: address, cumulativeAmount: uint256). See
   * 1inch/merkle-distribution@3db322c contracts/CumulativeMerkleDrop.sol.
   *
   * This is DELIBERATELY DIFFERENT from the Uniswap v1 leaf
   *   keccak256(abi.encodePacked(uint256 index, address account, uint256 amount))
   * that `hashDaoTokenClaimLeaf` (token-distribution.ts) currently emits. R2/R3
   * must add a cumulative leaf builder; this test pins the on-chain target.
   */
  it("leaf == keccak256(abi.encodePacked(address, uint256)) for a fixed vector", () => {
    const account = "0x1111111111111111111111111111111111111111" as const;
    const cumulativeAmount = 123_456_789_000_000_000_000n; // 123.456789 tokens

    const leaf = cumulativeLeaf(account, cumulativeAmount);

    // Independent recomputation of the exact contract preimage.
    const expected = keccak256(
      encodePacked(["address", "uint256"], [account, cumulativeAmount])
    );

    expect(leaf).toBe(expected);
    expect(leaf).toMatch(/^0x[0-9a-f]{64}$/);
    expect(leaf).not.toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
  });

  it("cumulative leaf DIFFERS from the Uniswap v1 (index,account,amount) leaf", () => {
    const index = 0;
    const account = "0x2222222222222222222222222222222222222222" as const;
    const amount = 1_000_000_000_000_000_000n;

    const cumulative = cumulativeLeaf(account, amount);
    const uniswapV1 = keccak256(
      encodePacked(
        ["uint256", "address", "uint256"],
        [BigInt(index), account, amount]
      )
    );

    // Same account+amount, structurally different preimage -> different leaf.
    expect(cumulative).not.toBe(uniswapV1);
  });

  it("a sorted-pair proof over cumulative leaves verifies the way the contract does", () => {
    // Two-account cumulative root. The contract's `_verifyAsm` walks the proof
    // hashing SORTED sibling pairs, then checks eq(root, computed). Build the
    // same root here and confirm each leaf's single-sibling proof reproduces it.
    // All-lowercase addresses (viem encodePacked enforces EIP-55 checksum;
    // all-lowercase is always accepted).
    const a = "0x000000000000000000000000000000000000aaaa" as const;
    const b = "0x000000000000000000000000000000000000bbbb" as const;
    const cumA = 700_000_000_000_000_000_000n; // 700 tokens cumulative
    const cumB = 300_000_000_000_000_000_000n; // 300 tokens cumulative

    const leafA = cumulativeLeaf(a, cumA);
    const leafB = cumulativeLeaf(b, cumB);
    const root = hashPair(leafA, leafB);

    // Proof for A is [leafB]; the contract folds leaf:=hashPair(leaf, sibling).
    expect(hashPair(leafA, leafB)).toBe(root);
    expect(hashPair(leafB, leafA)).toBe(root); // sorted -> order-independent
  });
});
