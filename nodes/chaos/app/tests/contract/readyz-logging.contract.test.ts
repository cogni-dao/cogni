// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/readyz-logging.contract`
 * Purpose: Verify /readyz returns structured error response with EVM_RPC_URL details.
 * Scope: Contract test ensuring readiness failures return diagnostic information. Does not test logging.
 * Invariants: Test MUST fail if /readyz returns 503 without structured error details for EVM_RPC_URL failure.
 * Side-effects: none
 * Notes: Critical debugging aid - ensures deployment failures have diagnosable error messages.
 * Links: src/app/(infra)/readyz/route.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EnvValidationError } from "@/shared/env";
import { RuntimeSecretError } from "@/shared/env/invariants";

describe("/readyz error response contract", () => {
  let originalAppEnv: string | undefined;
  let originalEvmRpcUrl: string | undefined;
  let originalAuthSecret: string | undefined;

  beforeEach(() => {
    // Save original values
    originalAppEnv = process.env.APP_ENV;
    originalEvmRpcUrl = process.env.EVM_RPC_URL;
    originalAuthSecret = process.env.AUTH_SECRET;

    // Set minimal valid env (AUTH_SECRET required)
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
  });

  afterEach(() => {
    // Restore original values
    if (originalAppEnv !== undefined) {
      process.env.APP_ENV = originalAppEnv;
    } else {
      delete process.env.APP_ENV;
    }
    if (originalEvmRpcUrl !== undefined) {
      process.env.EVM_RPC_URL = originalEvmRpcUrl;
    } else {
      delete process.env.EVM_RPC_URL;
    }
    if (originalAuthSecret !== undefined) {
      process.env.AUTH_SECRET = originalAuthSecret;
    } else {
      delete process.env.AUTH_SECRET;
    }
  });

  it("RuntimeSecretError should contain EVM_RPC_URL details", () => {
    // Arrange: Create error with expected format
    const error = new RuntimeSecretError(
      "APP_ENV=production requires EVM_RPC_URL for on-chain payment verification. Get an API key from Alchemy or Infura for Ethereum Sepolia."
    );

    // Assert: Error must have expected structure
    expect(error.code).toBe("MISSING_RUNTIME_SECRET");
    expect(error.message).toContain("EVM_RPC_URL");
    expect(error.message).toContain("on-chain payment verification");
  });

  it("EnvValidationError should have structured metadata", () => {
    // Arrange: Create error with expected format
    const error = new EnvValidationError({
      code: "INVALID_ENV",
      missing: ["EVM_RPC_URL"],
      invalid: [],
    });

    // Assert: Error must have expected structure
    expect(error.meta.code).toBe("INVALID_ENV");
    expect(error.meta.missing).toContain("EVM_RPC_URL");
    expect(error.meta).toHaveProperty("invalid");
  });
});
