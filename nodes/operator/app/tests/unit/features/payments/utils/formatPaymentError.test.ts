// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/payments/utils/formatPaymentError`
 * Purpose: Verify payment errors map to a structured, actionable, MINIFICATION-SAFE result.
 * Scope: Unit test of the pure classifier. Does not touch the UI or wagmi.
 * Invariants:
 *   - The ERC-20 "transfer amount exceeds balance" revert resolves to INSUFFICIENT_BALANCE
 *     EVEN WHEN the error class name is mangled (the prod-bundle failure mode).
 *   - Backend codes win first; every result carries a title + message + recoverable.
 * Side-effects: none
 * Links: src/features/payments/utils/formatPaymentError.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import { formatPaymentError } from "@/features/payments/utils/formatPaymentError";

describe("formatPaymentError", () => {
  it("classifies an ERC-20 'exceeds balance' revert as INSUFFICIENT_BALANCE", () => {
    const err = new Error(
      'The contract function "transfer" reverted with the following reason:\nERC20: transfer amount exceeds balance'
    );
    const out = formatPaymentError(err);
    expect(out.code).toBe("INSUFFICIENT_BALANCE");
    expect(out.title.toLowerCase()).toContain("usdc");
    expect(out.hint?.toLowerCase()).toContain("base");
    expect(out.recoverable).toBe(true);
  });

  it("is MINIFICATION-SAFE: matches the reason text even when the class name is mangled", () => {
    // Simulates a viem error in a minified prod bundle: constructor.name is a short hash,
    // but the revert reason is still on the message. The old code gated on constructor.name
    // and silently fell through to "Something went wrong"; this must NOT.
    class Yx extends Error {}
    const err = new Yx(
      "execution reverted: ERC20: transfer amount exceeds balance"
    );
    expect(err.constructor.name).toBe("Yx"); // not "ContractFunctionExecutionError"
    expect(formatPaymentError(err).code).toBe("INSUFFICIENT_BALANCE");
  });

  it("reads the revert reason from a nested cause", () => {
    const err = Object.assign(new Error("Transaction failed"), {
      cause: { reason: "ERC20: transfer amount exceeds balance" },
    });
    expect(formatPaymentError(err).code).toBe("INSUFFICIENT_BALANCE");
  });

  it("classifies a user rejection as USER_REJECTED (expected, recoverable)", () => {
    const err = new Error("User rejected the request.");
    const out = formatPaymentError(err);
    expect(out.code).toBe("USER_REJECTED");
    expect(out.recoverable).toBe(true);
  });

  it("classifies missing gas as INSUFFICIENT_GAS, distinct from USDC", () => {
    const err = new Error("insufficient funds for gas * price + value");
    expect(formatPaymentError(err).code).toBe("INSUFFICIENT_GAS");
  });

  it("prefers a backend error code over text matching", () => {
    const out = formatPaymentError({ code: "INTENT_EXPIRED" });
    expect(out.code).toBe("INTENT_EXPIRED");
    expect(out.title).toBeTruthy();
  });

  it("falls back to a calm, recoverable UNKNOWN — never a raw string", () => {
    const out = formatPaymentError(new Error("totally novel failure xyz"));
    expect(out.code).toBe("UNKNOWN");
    expect(out.recoverable).toBe(true);
    expect(out.title).toBeTruthy();
    expect(out.message).toBeTruthy();
  });

  it("never returns an empty title or message", () => {
    for (const input of [null, undefined, "string error", new Error("")]) {
      const out = formatPaymentError(input);
      expect(out.title.length).toBeGreaterThan(0);
      expect(out.message.length).toBeGreaterThan(0);
    }
  });
});
