// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/ids`
 * Purpose: Deterministic test user identity constants for unit/contract tests.
 * Scope: Provides branded UserId and SessionUser fixtures. Does not create real DB records.
 * Invariants:
 * - Uses toUserId() for validation — same path as production edges.
 * - Deterministic by default; random helpers are opt-in for tests that need uniqueness.
 * - Wallet addresses are valid Ethereum length (0x + 40 hex chars), unique per user.
 * Side-effects: none
 * Links: packages/ids/src/index.ts, @/shared/auth (SessionUser)
 * @public
 */

import { randomBytes, randomUUID } from "node:crypto";
import { toUserId, type UserId } from "@cogni/ids";
import type { SessionUser } from "@cogni/node-shared";

// --- Deterministic test users (stable UUIDs for reproducible tests) ---

export const TEST_USER_ID_1: UserId = toUserId(
  "00000000-0000-4000-a000-000000000001"
);
export const TEST_USER_ID_2: UserId = toUserId(
  "00000000-0000-4000-a000-000000000002"
);
export const TEST_USER_ID_3: UserId = toUserId(
  "00000000-0000-4000-a000-000000000003"
);
export const TEST_USER_ID_4: UserId = toUserId(
  "00000000-0000-4000-a000-000000000004"
);
export const TEST_USER_ID_5: UserId = toUserId(
  "00000000-0000-4000-a000-000000000005"
);

/** Deterministic valid-length Ethereum wallets, unique per test user. */
export const TEST_WALLET_1 = `0x${"0".repeat(39)}1`;
export const TEST_WALLET_2 = `0x${"0".repeat(39)}2`;
export const TEST_WALLET_3 = `0x${"0".repeat(39)}3`;
export const TEST_WALLET_4 = `0x${"0".repeat(39)}4`;
export const TEST_WALLET_5 = `0x${"0".repeat(39)}5`;

export const TEST_SESSION_USER_1: SessionUser = {
  id: TEST_USER_ID_1,
  walletAddress: TEST_WALLET_1,
};
export const TEST_SESSION_USER_2: SessionUser = {
  id: TEST_USER_ID_2,
  walletAddress: TEST_WALLET_2,
};
export const TEST_SESSION_USER_3: SessionUser = {
  id: TEST_USER_ID_3,
  walletAddress: TEST_WALLET_3,
};
export const TEST_SESSION_USER_4: SessionUser = {
  id: TEST_USER_ID_4,
  walletAddress: TEST_WALLET_4,
};
export const TEST_SESSION_USER_5: SessionUser = {
  id: TEST_USER_ID_5,
  walletAddress: TEST_WALLET_5,
};

/** Lookup a deterministic test session user by index (1–5). */
export function testUser(n: 1 | 2 | 3 | 4 | 5): SessionUser {
  const users = [
    TEST_SESSION_USER_1,
    TEST_SESSION_USER_2,
    TEST_SESSION_USER_3,
    TEST_SESSION_USER_4,
    TEST_SESSION_USER_5,
  ] as const;
  return users[n - 1];
}

// --- System tenant (matches seeded migration records) ---

export {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";

/** Mock billing account row for the system tenant. */
export const SYSTEM_BILLING_ACCOUNT = {
  id: "00000000-0000-4000-b000-000000000000",
  ownerUserId: "00000000-0000-4000-a000-000000000001",
  defaultVirtualKeyId: "vk-system-default",
} as const;

// --- Random helpers (opt-in for tests that need uniqueness) ---

/** Create a random valid UserId. Use only when test needs a unique identity. */
export function newTestUserId(): UserId {
  return toUserId(randomUUID());
}

/** Generate a random valid-length Ethereum wallet address. */
function generateTestWallet(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

/** Create a test SessionUser with random UserId and wallet. */
export function newTestSessionUser(
  overrides?: Partial<SessionUser>
): SessionUser {
  return {
    id: overrides?.id ?? newTestUserId(),
    walletAddress: overrides?.walletAddress ?? generateTestWallet(),
  };
}
