// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/payments/split-payment-rail-guard.adapter`
 * Purpose: Unit tests for the payment intent fail-closed Split config guard.
 * Scope: Verifies Split hash matching using fake EVM reads; does not hit network or sign transactions.
 * Links: src/adapters/server/payments/split-payment-rail-guard.adapter.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import { SplitPaymentRailGuardAdapter } from "@/adapters/server/payments/split-payment-rail-guard.adapter";
import { FakeEvmOnchainClient } from "@/adapters/test/onchain/fake-evm-onchain-client.adapter";
import type { PaymentRailMisconfiguredPortError } from "@/ports";

const OPERATOR_ADDRESS = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
const TREASURY_ADDRESS = "0xF61c3fafD4D34b4568e7a500d92b28Ac175e83C6";

// REAL on-chain `splitHash()` values of Push Split V2o2 contracts deployed to
// Base mainnet (chainId 8453), verified against the chain. The guard's expected
// hash MUST equal these — they are `keccak256(abi.encode(SplitV2 struct))` with
// recipients sorted ascending by lowercased address. The 0xSplits SDK's
// `hashSplitV2` does NOT reproduce these (the bug this regression test locks).

// 92.1053 / 7.8947 split (operator 921053 / treasury 78947, total 1000000).
// markup_factor 1.142857, revenue_share 0 produces this allocation.
// Deployed at 0xDe4dE5e40f7215E4606c3e422D28cf01f97C8c66.
const MARKUP_FACTOR_92_8 = 1.142857;
const SPLIT_ADDRESS_92_8 = "0xDe4dE5e40f7215E4606c3e422D28cf01f97C8c66";
const ONCHAIN_HASH_92_8 =
  "0x797a28c268a8767e42d36b0fc35e9b806881f081e56cb7d0b29a85757aa3b0f3";

// 95.0001 / 4.9999 split (operator 950001 / treasury 49999, total 1000000).
// markup_factor 1.10803324099723, revenue_share 0 produces this allocation.
// Deployed at 0x4C4e559B2117AbA5f8BaE8a37d4B26BBAdc4C294.
const MARKUP_FACTOR_95_5 = 1.10803324099723;
const SPLIT_ADDRESS_95_5 = "0x4C4e559B2117AbA5f8BaE8a37d4B26BBAdc4C294";
const ONCHAIN_HASH_95_5 =
  "0xe62078796d90766dd09550d8997c3e067ba271a25a0c664ea289a1871ecb2943";

function makeGuard(fake = new FakeEvmOnchainClient()) {
  return new SplitPaymentRailGuardAdapter(fake, {
    operatorAddress: OPERATOR_ADDRESS,
    treasuryAddress: TREASURY_ADDRESS,
  });
}

describe("SplitPaymentRailGuardAdapter", () => {
  it("passes when the on-chain Split hash matches repo-spec economics", async () => {
    const fake = new FakeEvmOnchainClient();
    fake.setBytecode(SPLIT_ADDRESS_92_8, "0x01");
    fake.setReadContractResult({
      address: SPLIT_ADDRESS_92_8,
      functionName: "splitHash",
      args: [],
      result: ONCHAIN_HASH_92_8,
    });

    await expect(
      makeGuard(fake).assertReady({
        chainId: 8453,
        receivingAddress: SPLIT_ADDRESS_92_8,
        markupFactor: MARKUP_FACTOR_92_8,
        revenueShare: 0,
      })
    ).resolves.toBeUndefined();
  });

  it("fails closed when the on-chain Split hash does not match repo-spec economics", async () => {
    const fake = new FakeEvmOnchainClient();
    fake.setBytecode(SPLIT_ADDRESS_92_8, "0x01");
    fake.setReadContractResult({
      address: SPLIT_ADDRESS_92_8,
      functionName: "splitHash",
      args: [],
      result: `0x${"00".repeat(32)}`,
    });

    await expect(
      makeGuard(fake).assertReady({
        chainId: 8453,
        receivingAddress: SPLIT_ADDRESS_92_8,
        markupFactor: MARKUP_FACTOR_92_8,
        revenueShare: 0,
      })
    ).rejects.toMatchObject({
      code: "SPLIT_CONFIG_MISMATCH",
    } satisfies Partial<PaymentRailMisconfiguredPortError>);
  });

  // Regression lock: the guard's expected hash must reproduce the REAL on-chain
  // `splitHash()` via keccak256(abi.encode(SplitV2 struct)), NOT the SDK's
  // hashSplitV2. These assertions fail if the hashing method ever regresses.
  describe("expected hash matches real on-chain splitHash() (regression lock)", () => {
    it("reproduces the 92.1053/7.8947 split on-chain hash", async () => {
      const fake = new FakeEvmOnchainClient();
      fake.setBytecode(SPLIT_ADDRESS_92_8, "0x01");
      fake.setReadContractResult({
        address: SPLIT_ADDRESS_92_8,
        functionName: "splitHash",
        args: [],
        // Mismatch on purpose so the thrown error exposes the computed expectedHash.
        result: `0x${"11".repeat(32)}`,
      });

      const err = await makeGuard(fake)
        .assertReady({
          chainId: 8453,
          receivingAddress: SPLIT_ADDRESS_92_8,
          markupFactor: MARKUP_FACTOR_92_8,
          revenueShare: 0,
        })
        .then(
          () => {
            throw new Error("expected assertReady to throw");
          },
          (e: PaymentRailMisconfiguredPortError) => e
        );

      expect(err.code).toBe("SPLIT_CONFIG_MISMATCH");
      expect(
        (err.details as { expectedHash: string }).expectedHash.toLowerCase()
      ).toBe(ONCHAIN_HASH_92_8);
    });

    it("reproduces the 95.0001/4.9999 split on-chain hash", async () => {
      const fake = new FakeEvmOnchainClient();
      fake.setBytecode(SPLIT_ADDRESS_95_5, "0x01");
      fake.setReadContractResult({
        address: SPLIT_ADDRESS_95_5,
        functionName: "splitHash",
        args: [],
        result: ONCHAIN_HASH_95_5,
      });

      await expect(
        makeGuard(fake).assertReady({
          chainId: 8453,
          receivingAddress: SPLIT_ADDRESS_95_5,
          markupFactor: MARKUP_FACTOR_95_5,
          revenueShare: 0,
        })
      ).resolves.toBeUndefined();
    });
  });
});
