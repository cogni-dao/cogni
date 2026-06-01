// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/auth/db-helpers`
 * Purpose: Database seeding helpers for auth testing.
 * Scope: Provides reusable helpers for creating test users, billing accounts, and virtual keys. Does not contain test assertions.
 * Invariants: Auto-generates IDs; maintains referential integrity
 * Side-effects: IO (database writes)
 * Notes: Use for integration and stack tests that need pre-seeded auth data.
 * Links: tests/component/auth/, tests/stack/auth/
 * @public
 */

import { randomUUID } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import type { Database } from "@/adapters/server/db/client";
import { billingAccounts, users, virtualKeys } from "@/shared/db/schema";

export interface SeedUserParams {
  id?: string;
  walletAddress?: string;
  name?: string;
  email?: string;
}

export interface SeedBillingParams {
  balanceCredits?: number | bigint;
  virtualKeyLabel?: string;
}

export interface SeededAuthData {
  user: typeof users.$inferSelect;
  billingAccount: typeof billingAccounts.$inferSelect;
  virtualKey: typeof virtualKeys.$inferSelect;
}

/**
 * Generate a unique test wallet address from UUID
 *
 * IMPORTANT: All tests must use this helper; never hard-code wallet addresses like 0x111...
 * to avoid cross-file collisions in the shared stack test database.
 *
 * @param label - Optional label for debugging (unused, reserved for future logging)
 * @returns Ethereum-style address (0x + 40 hex chars) derived from UUID, padded with zeros
 */
export function generateTestWallet(_label?: string): string {
  // UUID without dashes = 32 hex chars, need 40 for Ethereum address
  const uuid = randomUUID().replace(/-/g, "");
  return `0x${uuid}${"0".repeat(8)}`; // Pad with 8 zeros to reach 40 chars
}

/**
 * Seed a complete authenticated user with billing account and virtual key
 */
export async function seedAuthenticatedUser(
  db: Database,
  userParams: SeedUserParams = {},
  billingParams: SeedBillingParams = {}
): Promise<SeededAuthData> {
  const walletAddress = userParams.walletAddress ?? generateTestWallet();

  // Create user
  const [user] = await db
    .insert(users)
    .values({
      id: userParams.id ?? walletAddress.toLowerCase(),
      walletAddress,
      name: userParams.name ?? `Test User ${walletAddress.slice(0, 8)}`,
      email: userParams.email ?? null,
    })
    .returning();

  if (!user) {
    throw new Error("Failed to create test user");
  }

  // Create billing account
  // Protocol scale: 10M credits = $1 USD. Default to $10 worth.
  const [billingAccount] = await db
    .insert(billingAccounts)
    .values({
      id: `billing-${user.id}`,
      ownerUserId: user.id,
      balanceCredits: BigInt(billingParams.balanceCredits ?? 100_000_000),
    })
    .returning();

  if (!billingAccount) {
    throw new Error("Failed to create test billing account");
  }

  // MVP: virtual_keys is scope/FK handle only. Auth uses LITELLM_MASTER_KEY from env.
  const [virtualKey] = await db
    .insert(virtualKeys)
    .values({
      billingAccountId: billingAccount.id,
      label: billingParams.virtualKeyLabel ?? "Test Default",
      isDefault: true,
      active: true,
    })
    .returning();

  if (!virtualKey) {
    throw new Error("Failed to create test virtual key");
  }

  return { user, billingAccount, virtualKey };
}

/**
 * Create a mock SessionUser for testing (no DB write)
 */
export function createMockSessionUser(
  overrides: Partial<SessionUser> = {}
): SessionUser {
  return {
    id: overrides.id ?? "00000000-0000-4000-a000-000000000001",
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    ...overrides,
  };
}
