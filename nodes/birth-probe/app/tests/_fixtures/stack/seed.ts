// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/stack/seed`
 * Purpose: Reusable test seeding utilities for stack tests.
 * Scope: Provides seedUser, seedBillingAccount, seedTestActor for setting up test data. Does not contain test logic.
 * Invariants:
 *   - Insert order respects FK constraints (users → billing_accounts)
 *   - Idempotent via onConflictDoNothing with explicit target
 *   - Generates crypto-safe wallet addresses (not derived from UUID)
 * Side-effects: IO (database inserts)
 * Links: tests/stack/*, schema.auth.ts, schema.billing.ts
 * @public
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import type { Database } from "@/adapters/server/db/client";
import {
  billingAccounts,
  linkTransactions,
  users,
  virtualKeys,
} from "@/shared/db";

/**
 * Test actor with user credentials and billing account.
 */
export interface TestActor {
  user: SessionUser;
  billingAccountId: string;
  virtualKeyId: string;
}

/**
 * Generates a valid Ethereum wallet address (0x + 40 hex chars).
 */
function generateWalletAddress(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

/**
 * Seeds a user into the database.
 * Idempotent: does nothing if user with same ID already exists.
 */
export async function seedUser(
  db: Database,
  user: { id: string; walletAddress?: string; name?: string }
): Promise<void> {
  await db
    .insert(users)
    .values({
      id: user.id,
      name: user.name ?? "Test User",
      walletAddress: user.walletAddress ?? generateWalletAddress(),
    })
    .onConflictDoNothing({ target: users.id });
}

/**
 * Seeds a billing account. Requires user to exist first (FK constraint).
 * Idempotent: does nothing if billing account with same ID already exists.
 */
export async function seedBillingAccount(
  db: Database,
  params: {
    userId: string;
    billingAccountId: string;
    balanceCredits?: bigint;
  }
): Promise<{ billingAccountId: string }> {
  await db
    .insert(billingAccounts)
    .values({
      id: params.billingAccountId,
      ownerUserId: params.userId,
      balanceCredits: params.balanceCredits ?? 100_000_000n, // $10 protocol scale
    })
    .onConflictDoNothing({ target: billingAccounts.id });

  return { billingAccountId: params.billingAccountId };
}

/**
 * Seeds a virtual key. Requires billing account to exist first (FK constraint).
 * Idempotent: does nothing if virtual key with same ID already exists.
 */
export async function seedVirtualKey(
  db: Database,
  params: {
    billingAccountId: string;
    virtualKeyId: string;
    isDefault?: boolean;
  }
): Promise<{ virtualKeyId: string }> {
  await db
    .insert(virtualKeys)
    .values({
      id: params.virtualKeyId,
      billingAccountId: params.billingAccountId,
      isDefault: params.isDefault ?? true,
      label: "Test Default Key",
    })
    .onConflictDoNothing({ target: virtualKeys.id });

  return { virtualKeyId: params.virtualKeyId };
}

/**
 * Seeds a link transaction row for fail-closed account linking tests.
 * Returns the txId for use in PendingLinkIntent mock values.
 * Requires user to exist first (FK constraint).
 */
export async function seedLinkTransaction(
  db: Database,
  params: {
    userId: string;
    provider: string;
    txId?: string;
    expiresAt?: Date;
  }
): Promise<string> {
  const txId = params.txId ?? randomUUID();
  await db.insert(linkTransactions).values({
    id: txId,
    userId: params.userId,
    provider: params.provider,
    expiresAt: params.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
  });
  return txId;
}

/**
 * Seeds a complete test actor (user + billing account + default virtual key).
 * Returns SessionUser-compatible object for mocking getSessionUser.
 *
 * @param db - Database instance
 * @param opts - Optional explicit IDs for debuggability; generates if not provided
 */
export async function seedTestActor(
  db: Database,
  opts?: {
    userId?: string;
    walletAddress?: string;
    billingAccountId?: string;
    virtualKeyId?: string;
    balanceCredits?: bigint;
  }
): Promise<TestActor> {
  const userId = opts?.userId ?? randomUUID();
  const walletAddress = opts?.walletAddress ?? generateWalletAddress();
  const billingAccountId = opts?.billingAccountId ?? randomUUID();
  const virtualKeyId = opts?.virtualKeyId ?? randomUUID();

  await seedUser(db, { id: userId, walletAddress });
  await seedBillingAccount(db, {
    userId,
    billingAccountId,
    balanceCredits: opts?.balanceCredits,
  });
  await seedVirtualKey(db, {
    billingAccountId,
    virtualKeyId,
    isDefault: true,
  });

  return {
    user: { id: userId, walletAddress },
    billingAccountId,
    virtualKeyId,
  };
}
