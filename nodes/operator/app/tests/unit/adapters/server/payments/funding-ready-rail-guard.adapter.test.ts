// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/payments/funding-ready-rail-guard.adapter`
 * Purpose: Unit tests for the outbound-funding fail-closed rail guard composer.
 * Scope: Verifies the guard refuses intents when funding is unwired and delegates
 *   to the inner guard when funding is ready. No chain reads.
 * Links: src/adapters/server/payments/funding-ready-rail-guard.adapter.ts, bug.5087
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { FundingReadyRailGuardAdapter } from "@/adapters/server/payments/funding-ready-rail-guard.adapter";
import {
  isPaymentRailMisconfiguredPortError,
  type PaymentRailGuardConfig,
  type PaymentRailGuardPort,
} from "@/ports";

const CONFIG: PaymentRailGuardConfig = {
  chainId: 8453,
  receivingAddress: "0x4C4e559B2117AbA5f8BaE8a37d4B26BBAdc4C294",
  markupFactor: 1.142857,
  revenueShare: 0,
};

function inner(): PaymentRailGuardPort {
  return { assertReady: vi.fn(async () => undefined) };
}

describe("FundingReadyRailGuardAdapter", () => {
  it("fails closed with PAYMENT_RAIL_UNCONFIGURED when funding is NOT wired", async () => {
    const innerGuard = inner();
    const guard = new FundingReadyRailGuardAdapter(innerGuard, false);

    await expect(guard.assertReady(CONFIG)).rejects.toSatisfy(
      (err: unknown) => {
        return (
          isPaymentRailMisconfiguredPortError(err) &&
          err.code === "PAYMENT_RAIL_UNCONFIGURED" &&
          /outbound funding not configured/.test(err.message)
        );
      }
    );
    // Inner (chain-reading) guard is never consulted — we refuse before any read.
    expect(innerGuard.assertReady).not.toHaveBeenCalled();
  });

  it("delegates to the inner guard when funding IS wired", async () => {
    const innerGuard = inner();
    const guard = new FundingReadyRailGuardAdapter(innerGuard, true);

    await expect(guard.assertReady(CONFIG)).resolves.toBeUndefined();
    expect(innerGuard.assertReady).toHaveBeenCalledWith(CONFIG);
  });

  it("propagates the inner guard's misconfiguration when funding is wired but inbound fails", async () => {
    const innerGuard: PaymentRailGuardPort = {
      assertReady: vi.fn(async () => {
        const { PaymentRailMisconfiguredPortError } = await import("@/ports");
        throw new PaymentRailMisconfiguredPortError(
          "SPLIT_CONFIG_MISMATCH",
          "boom"
        );
      }),
    };
    const guard = new FundingReadyRailGuardAdapter(innerGuard, true);

    await expect(guard.assertReady(CONFIG)).rejects.toSatisfy(
      (err: unknown) =>
        isPaymentRailMisconfiguredPortError(err) &&
        err.code === "SPLIT_CONFIG_MISMATCH"
    );
  });
});
