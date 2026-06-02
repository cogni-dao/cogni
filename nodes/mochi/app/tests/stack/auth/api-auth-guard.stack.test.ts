// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/auth/api-auth-guard.stack`
 * Purpose: Verify protected APIs enforce session-only authentication end-to-end.
 * Scope: Tests /api/v1/ai/* routes with and without valid NextAuth session cookies. Validates proxy.ts middleware and per-route session enforcement. Does not test UI or client-side auth flows.
 * Invariants: Unauthenticated requests return 401; authenticated requests with valid session succeed; no bypass via missing middleware
 * Side-effects: IO (HTTP requests, database writes, LLM service calls)
 * Notes: Uses synthetic sessions not SIWE; See siwe-session.stack.test.ts for SIWE pipeline; Focuses on API auth and billing
 * Links: docs/spec/security-auth.md, src/proxy.ts, tests/stack/auth/siwe-session.stack.test.ts
 * @public
 */

import { generateTestWallet } from "@tests/_fixtures/auth/siwe-helpers";
import { createSyntheticSession } from "@tests/_fixtures/auth/synthetic-session";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { billingAccounts, users, virtualKeys } from "@/shared/db/schema";

function baseUrl(path = ""): string {
  const root = process.env.TEST_BASE_URL ?? "http://localhost:3000";
  return path ? new URL(path.replace(/^\//, ""), root).toString() : root;
}

describe("API Auth Guard Stack Test", () => {
  it("should return 401 when calling /api/v1/chat/completions without session", async () => {
    // Arrange: Prepare valid request body
    const requestBody = {
      messages: [{ role: "user", content: "Hello AI" }],
    };

    // Act: Call protected endpoint without auth cookie
    const response = await fetch(`${baseUrl()}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    // Assert: Should be rejected with 401
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data).toHaveProperty("error");
    expect(data.error).toMatch(/unauthorized|session/i);
  });

  // TODO: Re-enable after RainbowKitSiweNextAuth refactor stabilizes
  // Current blocker: synthetic JWT sessions fail JWE decryption in route handlers
  // See: docs/spec/authentication.md (deferred_work section)
  // See: tests/_fixtures/auth/synthetic-session.ts (JWE format notes)
  it.skip("should return 200 when calling /api/v1/chat/completions with valid session and seeded billing account", async () => {
    // Arrange: Create test wallet and synthetic session
    const wallet = generateTestWallet("test-api-guard-wallet");
    const walletAddress = wallet.account.address.toLowerCase();

    // Create synthetic NextAuth session token (bypasses SIWE flow)
    const sessionCookie = await createSyntheticSession({
      walletAddress,
    });

    // Seed user, billing account, and virtual key in database
    const db = getSeedDb();

    await db.insert(users).values({
      id: walletAddress,
      name: "API Guard Test User",
      walletAddress,
    });

    const billingAccountId = `billing-${walletAddress}`;

    await db.insert(billingAccounts).values({
      id: billingAccountId,
      ownerUserId: walletAddress,
      balanceCredits: 1000n, // Sufficient credits
    });

    await db.insert(virtualKeys).values({
      billingAccountId,
      label: "Test Default",
      isDefault: true,
      active: true,
    });

    // Arrange: Prepare request body
    const requestBody = {
      messages: [{ role: "user", content: "Hello AI from authenticated user" }],
    };

    // Act: Call protected endpoint with synthetic session cookie
    const response = await fetch(`${baseUrl()}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      },
      body: JSON.stringify(requestBody),
    });

    // Assert: Should succeed with 200
    if (response.status !== 200) {
      const errorText = await response.text();
      console.error(`API call failed with ${response.status}:`, errorText);
    }
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("choices");
    expect(data.choices[0].message).toHaveProperty("role", "assistant");
    expect(data.choices[0].message).toHaveProperty("content");
    expect(typeof data.choices[0].message.content).toBe("string");

    // Verify billing account balance was updated (side effect)
    const updatedBillingAccount = await db.query.billingAccounts.findFirst({
      where: eq(billingAccounts.id, billingAccountId),
    });

    expect(updatedBillingAccount).toBeDefined();
    expect(updatedBillingAccount?.balanceCredits).toBeLessThan(1000n); // Credits were deducted
  });

  it("should enforce auth at proxy level (middleware) for /api/v1/ai/* routes", async () => {
    // This test validates that src/proxy.ts catches unauthenticated requests
    // before they reach the route handler

    // Act: Call various /api/v1/ai/* endpoints without auth
    const endpoints = ["/api/v1/chat/completions"];

    for (const endpoint of endpoints) {
      const response = await fetch(`${baseUrl()}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: [] }),
      });

      // Assert: All should return 401
      expect(response.status).toBe(401);
    }
  });

  // TODO: Re-enable after RainbowKitSiweNextAuth refactor stabilizes
  // Current blocker: synthetic JWT sessions fail JWE decryption in route handlers
  // See: docs/spec/authentication.md (deferred_work section)
  it.skip("should allow authenticated requests through proxy and reach route handler", async () => {
    // Arrange: Create synthetic authenticated session
    const wallet = generateTestWallet("test-proxy-auth-wallet");
    const walletAddress = wallet.account.address.toLowerCase();

    // Create synthetic NextAuth session token (bypasses SIWE flow)
    const sessionCookie = await createSyntheticSession({
      walletAddress,
    });

    // Seed database (no billing account - should get 403/500 from route, not 401 from proxy)
    const db = getSeedDb();

    await db.insert(users).values({
      id: walletAddress,
      name: "Proxy Auth Test User",
      walletAddress,
    });

    // Act: Call endpoint with synthetic auth cookie but without billing account seeded
    const response = await fetch(`${baseUrl()}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Test" }],
      }),
    });

    // Assert: Should pass proxy (not 401) but fail at route level
    // The proxy allows authenticated requests through; route handler should
    // return a different error (e.g., 403 for no billing account)
    expect(response.status).not.toBe(401); // Proxy passed
    expect([403, 500]).toContain(response.status); // Route-level error
  });
});
