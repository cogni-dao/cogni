// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/auth/siwe-primitives`
 * Purpose: Unit tests for SIWE library primitives (domain/nonce/signature verification).
 * Scope: Tests the siwe library's verify() method directly to prove cryptographic verification works. Does not test NextAuth integration.
 * Invariants: Valid signature passes; domain/nonce/signature mismatches fail.
 * Side-effects: none
 * Notes: Tests the underlying crypto primitives that src/auth.ts:66-156 relies on. NextAuth integration tested via stack tests.
 * Links: src/auth.ts (lines 94-131), docs/spec/security-auth.md
 * @public
 */

import {
  createAndSignSiweMessage,
  generateTestWallet,
} from "@tests/_fixtures/auth/siwe-helpers";
import { SiweMessage } from "siwe";
import { describe, expect, it } from "vitest";

describe("SIWE Primitives", () => {
  const TEST_DOMAIN = "localhost:3000";
  const TEST_NONCE = "testnonce12345";

  it("should verify valid SIWE signature with correct domain and nonce", async () => {
    // Arrange
    const wallet = generateTestWallet("test-valid");
    const { message, signature } = await createAndSignSiweMessage(
      {
        domain: TEST_DOMAIN,
        address: wallet.account.address,
        nonce: TEST_NONCE,
        chainId: 1,
      },
      wallet
    );

    // Act
    const siweMessage = new SiweMessage(message);
    const verification = await siweMessage.verify({
      signature,
      domain: TEST_DOMAIN,
      nonce: TEST_NONCE,
    });

    // Assert
    expect(verification.success).toBe(true);
    expect(verification.data.address.toLowerCase()).toBe(
      wallet.account.address.toLowerCase()
    );
  });

  it("should reject SIWE signature with domain mismatch (spoofing protection)", async () => {
    // Arrange
    const wallet = generateTestWallet("test-domain-mismatch");
    const EVIL_DOMAIN = "evil.com";

    // Sign message with evil domain
    const { message, signature } = await createAndSignSiweMessage(
      {
        domain: EVIL_DOMAIN,
        address: wallet.account.address,
        nonce: TEST_NONCE,
        chainId: 1,
      },
      wallet
    );

    // Act & Assert - should throw/reject
    const siweMessage = new SiweMessage(message);
    await expect(
      siweMessage.verify({
        signature,
        domain: TEST_DOMAIN, // Different domain!
        nonce: TEST_NONCE,
      })
    ).rejects.toMatchObject({
      success: false,
      error: expect.objectContaining({
        type: expect.stringContaining("Domain"),
      }),
    });
  });

  it("should reject SIWE signature with nonce mismatch (replay protection)", async () => {
    // Arrange
    const wallet = generateTestWallet("test-nonce-mismatch");
    const WRONG_NONCE = "wrongnonce99";

    // Sign message with wrong nonce
    const { message, signature } = await createAndSignSiweMessage(
      {
        domain: TEST_DOMAIN,
        address: wallet.account.address,
        nonce: WRONG_NONCE,
        chainId: 1,
      },
      wallet
    );

    // Act & Assert - should throw/reject
    const siweMessage = new SiweMessage(message);
    await expect(
      siweMessage.verify({
        signature,
        domain: TEST_DOMAIN,
        nonce: TEST_NONCE, // Different nonce!
      })
    ).rejects.toMatchObject({
      success: false,
      error: expect.objectContaining({
        type: expect.stringContaining("Nonce"),
      }),
    });
  });

  it("should reject SIWE signature from wrong wallet (signature verification)", async () => {
    // Arrange
    const legitWallet = generateTestWallet("test-legit");
    const attackerWallet = generateTestWallet("test-attacker");

    // Attacker signs message claiming to be legit wallet
    const { message, signature } = await createAndSignSiweMessage(
      {
        domain: TEST_DOMAIN,
        address: legitWallet.account.address, // Claim to be legit
        nonce: TEST_NONCE,
        chainId: 1,
      },
      attackerWallet // But sign with attacker key
    );

    // Act & Assert - should throw/reject
    const siweMessage = new SiweMessage(message);
    await expect(
      siweMessage.verify({
        signature,
        domain: TEST_DOMAIN,
        nonce: TEST_NONCE,
      })
    ).rejects.toMatchObject({
      success: false,
      error: expect.objectContaining({
        type: expect.stringContaining("Signature"),
      }),
    });
  });

  it("should parse SIWE message and extract domain/nonce/address correctly", () => {
    // Arrange
    const wallet = generateTestWallet("test-parse");
    const message = `localhost:3000 wants you to sign in with your Ethereum account:
${wallet.account.address}

Sign in with Ethereum to the app.

URI: https://localhost:3000
Version: 1
Chain ID: 1
Nonce: ${TEST_NONCE}
Issued At: 2025-01-01T00:00:00.000Z`;

    // Act
    const siweMessage = new SiweMessage(message);

    // Assert
    expect(siweMessage.domain).toBe("localhost:3000");
    expect(siweMessage.nonce).toBe(TEST_NONCE);
    expect(siweMessage.address.toLowerCase()).toBe(
      wallet.account.address.toLowerCase()
    );
    expect(siweMessage.chainId).toBe(1);
  });
});
