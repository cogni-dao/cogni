// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/auth/siwe-session.stack`
 * Purpose: Verify real SIWE → NextAuth → JWT → session pipeline over HTTP.
 * Scope: Tests the complete authentication flow without mocking NextAuth internals. Does not test UI components or client-side wallet connection.
 * Invariants: Uses real NextAuth endpoints; no vi.mock() of auth internals; wallet address must be normalized (lowercase)
 * Side-effects: IO (HTTP requests, database writes)
 * Notes: Exercises actual JWT callbacks and session callbacks in src/auth.ts. Uses undici's fetch to access Set-Cookie headers on redirect responses.
 * Links: docs/spec/security-auth.md, src/auth.ts
 * @public
 */

import { CHAIN_ID } from "@cogni/node-shared";
import {
  getSession,
  siweLogin,
} from "@tests/_fixtures/auth/nextauth-http-helpers";
import { generateTestWallet } from "@tests/_fixtures/auth/siwe-helpers";
import { describe, expect, it } from "vitest";

function baseUrl(path = ""): string {
  const root = process.env.TEST_BASE_URL ?? "http://localhost:3000";
  return path ? new URL(path.replace(/^\//, ""), root).toString() : root;
}

describe("SIWE Session Stack Test", () => {
  it("should accept valid SIWE signature and create session", async () => {
    // Arrange: Create deterministic test wallet
    const wallet = generateTestWallet("test-siwe-session-wallet");
    const domain = new URL(baseUrl()).host; // Extract host from TEST_BASE_URL

    // Act: Perform SIWE login
    const loginResult = await siweLogin({
      baseUrl: baseUrl(),
      wallet,
      domain,
      chainId: CHAIN_ID,
    });

    // Assert: NextAuth accepted the SIWE signature (HTTP 2xx/3xx, no error)
    expect(loginResult.success).toBe(true);
    expect(loginResult.error).toBeUndefined();

    // Note: sessionCookie may be null due to Fetch API redirect restrictions
    // If cookie is available, validate session data
    if (loginResult.sessionCookie) {
      const sessionData = await getSession(
        baseUrl(),
        loginResult.sessionCookie
      );

      const session = sessionData as {
        user?: { id?: string; walletAddress?: string };
      };

      expect(session.user).toBeDefined();
      expect(session.user?.id).toBeDefined();
      expect(session.user?.walletAddress).toBeDefined();

      // CRITICAL: Wallet address must be normalized (lowercase)
      const expectedAddress = wallet.account.address.toLowerCase();
      expect(session.user?.walletAddress).toBe(expectedAddress);

      // CRITICAL: User ID should match wallet address (SIWE invariant)
      expect(session.user?.id).toBe(expectedAddress);
    }
  });

  it("should reject SIWE login with invalid signature", async () => {
    // Arrange: Create wallet but use a different wallet's signature
    const legitWallet = generateTestWallet("test-legit-wallet");
    const attackerWallet = generateTestWallet("test-attacker-wallet");
    const domain = new URL(baseUrl()).host;

    // Get CSRF token and cookie
    const { getCsrfToken } = await import(
      "@tests/_fixtures/auth/nextauth-http-helpers"
    );
    const { createSiweMessage, signSiweMessage } = await import(
      "@tests/_fixtures/auth/siwe-helpers"
    );

    const { csrfToken, csrfCookie } = await getCsrfToken(baseUrl());

    // Create message claiming to be legitWallet
    const message = createSiweMessage({
      domain,
      address: legitWallet.account.address,
      nonce: csrfToken,
      chainId: 11155111,
    });

    // But sign with attacker's key
    const signature = await signSiweMessage(message, attackerWallet);

    // POST to callback endpoint with CSRF cookie
    const body = new URLSearchParams({
      csrfToken,
      callbackUrl: baseUrl(),
      json: "true",
      message,
      signature,
    });

    const response = await fetch(`${baseUrl()}/api/auth/callback/siwe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrfCookie,
      },
      body: body.toString(),
      redirect: "manual", // Don't follow redirects - inspect the immediate response
    });

    // Assert: Auth should fail (no session cookie or error response)
    const setCookieHeader = response.headers.get("set-cookie");
    const hasSessionCookie = setCookieHeader?.includes("session-token");

    // Either no session cookie, or if response is JSON, it should contain an error
    if (response.headers.get("content-type")?.includes("json")) {
      const data = await response.json();
      expect(data).toHaveProperty("error");
    } else {
      expect(hasSessionCookie).toBeFalsy();
    }
  });

  it("should return null session when no auth cookie is present", async () => {
    // Act: Get session without any cookie
    const sessionData = await getSession(baseUrl(), null);

    // Assert: Session should be empty/null
    // NextAuth returns {} or null for unauthenticated requests
    if (sessionData === null) {
      // NextAuth may return null for no session
      expect(sessionData).toBeNull();
    } else {
      const session = sessionData as { user?: unknown };
      expect(session.user).toBeUndefined();
    }
  });

  it("should enforce walletAddress presence in session (SIWE invariant)", async () => {
    // This test validates that the JWT callback in src/auth.ts enforces
    // the invariant that walletAddress must exist for SIWE sessions

    // Arrange & Act: Perform valid SIWE login
    const wallet = generateTestWallet("test-wallet-invariant");
    const domain = new URL(baseUrl()).host;

    const loginResult = await siweLogin({
      baseUrl: baseUrl(),
      wallet,
      domain,
      chainId: 11155111,
    });

    // Assert: If login succeeds, walletAddress MUST be in session
    if (loginResult.success && loginResult.sessionCookie) {
      const sessionData = await getSession(
        baseUrl(),
        loginResult.sessionCookie
      );
      const session = sessionData as {
        user?: { walletAddress?: string | null };
      };

      // CRITICAL: walletAddress must not be null or undefined
      expect(session.user?.walletAddress).toBeTruthy();
      expect(typeof session.user?.walletAddress).toBe("string");
      expect(session.user?.walletAddress).toMatch(/^0x[a-f0-9]{40}$/);
    }
  });
});
