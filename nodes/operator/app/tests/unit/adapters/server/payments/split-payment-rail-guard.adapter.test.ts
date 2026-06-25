// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/payments/split-payment-rail-guard.adapter`
 * Purpose: Unit tests for the payment intent fail-closed Split config guard.
 * Scope: Verifies Split hash matching using fake EVM reads; does not hit network or sign transactions.
 * Links: src/adapters/server/payments/split-payment-rail-guard.adapter.ts
 * @internal
 */

import { hashSplitV2 } from "@0xsplits/splits-sdk/utils";
import {
  calculateSplitAllocations,
  numberToPpm,
  OPENROUTER_CRYPTO_FEE_PPM,
  SPLIT_TOTAL_ALLOCATION,
} from "@cogni/operator-wallet";
import { type Address, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { SplitPaymentRailGuardAdapter } from "@/adapters/server/payments/split-payment-rail-guard.adapter";
import { FakeEvmOnchainClient } from "@/adapters/test/onchain/fake-evm-onchain-client.adapter";
import type { PaymentRailMisconfiguredPortError } from "@/ports";

const TARGET_MARKUP_FACTOR = 1.10803324099723;
const OPERATOR_ADDRESS = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
const TREASURY_ADDRESS = "0xF61c3fafD4D34b4568e7a500d92b28Ac175e83C6";
const SPLIT_ADDRESS = "0xDe4dE5e40f7215E4606c3e422D28cf01f97C8c66";

function expectedSplitHash(): string {
  const { operatorAllocation, treasuryAllocation } = calculateSplitAllocations(
    numberToPpm(TARGET_MARKUP_FACTOR),
    numberToPpm(0),
    OPENROUTER_CRYPTO_FEE_PPM
  );

  const entries = [
    { address: getAddress(OPERATOR_ADDRESS), allocation: operatorAllocation },
    { address: getAddress(TREASURY_ADDRESS), allocation: treasuryAllocation },
  ].sort((a, b) =>
    a.address.toLowerCase().localeCompare(b.address.toLowerCase())
  );

  return hashSplitV2(
    entries.map((entry) => entry.address as Address),
    entries.map((entry) => entry.allocation),
    SPLIT_TOTAL_ALLOCATION,
    0
  );
}

function makeGuard(fake = new FakeEvmOnchainClient()) {
  return new SplitPaymentRailGuardAdapter(fake, {
    operatorAddress: OPERATOR_ADDRESS,
    treasuryAddress: TREASURY_ADDRESS,
  });
}

describe("SplitPaymentRailGuardAdapter", () => {
  it("passes when the on-chain Split hash matches repo-spec economics", async () => {
    const fake = new FakeEvmOnchainClient();
    fake.setBytecode(SPLIT_ADDRESS, "0x01");
    fake.setReadContractResult({
      address: SPLIT_ADDRESS,
      functionName: "splitHash",
      args: [],
      result: expectedSplitHash(),
    });

    await expect(
      makeGuard(fake).assertReady({
        chainId: 8453,
        receivingAddress: SPLIT_ADDRESS,
        markupFactor: TARGET_MARKUP_FACTOR,
        revenueShare: 0,
      })
    ).resolves.toBeUndefined();
  });

  it("fails closed when the on-chain Split hash does not match repo-spec economics", async () => {
    const fake = new FakeEvmOnchainClient();
    fake.setBytecode(SPLIT_ADDRESS, "0x01");
    fake.setReadContractResult({
      address: SPLIT_ADDRESS,
      functionName: "splitHash",
      args: [],
      result: `0x${"00".repeat(32)}`,
    });

    await expect(
      makeGuard(fake).assertReady({
        chainId: 8453,
        receivingAddress: SPLIT_ADDRESS,
        markupFactor: TARGET_MARKUP_FACTOR,
        revenueShare: 0,
      })
    ).rejects.toMatchObject({
      code: "SPLIT_CONFIG_MISMATCH",
    } satisfies Partial<PaymentRailMisconfiguredPortError>);
  });
});
