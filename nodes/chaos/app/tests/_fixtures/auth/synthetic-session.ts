// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/auth/synthetic-session`
 * Purpose: Create synthetic NextAuth-compatible JWT session tokens for testing.
 * Scope: Provides utilities to mint valid session cookies without going through the full SIWE HTTP flow. Does not perform actual SIWE signature verification.
 * Invariants: Uses same AUTH_SECRET and JWT structure as NextAuth; tokens are functionally identical to real NextAuth sessions
 * Side-effects: IO (reads AUTH_SECRET from environment)
 * Notes: For api-auth-guard tests needing valid sessions without SIWE flow; siwe-session.stack.test.ts is source of truth for SIWE
 * Links: src/auth.ts, tests/stack/auth/api-auth-guard.stack.test.ts
 *
 * DEFERRED: JWE vs JWT format issue
 * Current implementation uses encode() from next-auth/jwt, but NextAuth v4 expects JWE (encrypted JWT) format in some deployments.
 * Tests using synthetic sessions are SKIPPED pending RainbowKitSiweNextAuth refactor completion.
 * After refactor: revisit this approach or use real SIWE flow via test fixtures.
 * See: docs/spec/authentication.md (deferred_work section)
 *
 * @public
 */

import { randomUUID } from "node:crypto";

import { encode } from "next-auth/jwt";

import type { NextAuthSessionCookie } from "./nextauth-http-helpers";

export interface SyntheticSessionParams {
  walletAddress?: string | null;
  userId?: string; // Optional UUID v4 for user ID (defaults to random UUID)
  authSecret?: string;
}

/**
 * Create a synthetic NextAuth-compatible JWT session token for testing.
 *
 * This mints a JWT with the same structure and signing algorithm that NextAuth uses,
 * allowing tests to bypass the full SIWE HTTP flow while still exercising real
 * NextAuth session validation.
 *
 * @param params - Configuration including wallet address, optional userId (UUID v4), and auth secret
 * @param params.walletAddress - Ethereum wallet address
 * @param params.userId - Optional UUID v4 for user ID (defaults to random UUID)
 * @param params.authSecret - Optional auth secret (defaults to process.env.AUTH_SECRET)
 * @returns NextAuthSessionCookie with name and value ready to use in Cookie header
 */
export async function createSyntheticSession(
  params: SyntheticSessionParams
): Promise<NextAuthSessionCookie> {
  const secret = params.authSecret ?? process.env.AUTH_SECRET;

  if (!secret) {
    throw new Error("AUTH_SECRET not found in environment");
  }

  // Diagnostic logging (remove after debugging)
  console.log(
    "[Synthetic Session] Using secret:",
    `${secret.substring(0, 10)}...`
  );

  const address = params.walletAddress?.toLowerCase() ?? null;
  const userId = params.userId ?? randomUUID(); // Use provided UUID or generate one

  // Use NextAuth's own encode function to create a valid JWT
  // This ensures the token structure matches exactly what NextAuth expects
  const token = await encode({
    token: {
      id: userId, // Must be UUID v4 to match DB schema and validation
      walletAddress: address,
      name: address,
      email: null,
      picture: null,
      sub: address,
    },
    secret,
    salt: "next-auth.session-token", // NextAuth uses cookie name as salt
    maxAge: 30 * 24 * 60 * 60, // 30 days (matches auth.ts)
  });

  // Return cookie in NextAuth format
  return {
    name: "next-auth.session-token",
    value: token,
  };
}
