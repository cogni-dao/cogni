// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/auth/oauth-signin.stack`
 * Purpose: Stack tests for the OAuth signIn callback's DB-interacting paths against real Postgres.
 * Scope: Tests new-user creation, returning-user lookup, link-intent binding, idempotent linking, and NO_AUTO_MERGE rejection. Does not test SIWE flow or HTTP routing.
 * Invariants: Atomic user+binding+event creation; binding-based user resolution; NO_AUTO_MERGE enforcement.
 * Side-effects: IO (database reads/writes via getServiceDb and getSeedDb)
 * Links: src/auth.ts (signIn callback), packages/db-schema/src/identity.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import {
  newTestUserId,
  TEST_USER_ID_1,
  TEST_USER_ID_2,
  TEST_USER_ID_3,
  TEST_USER_ID_4,
  TEST_USER_ID_5,
  TEST_WALLET_2,
} from "@tests/_fakes/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedLinkTransaction, seedUser } from "@tests/_fixtures/stack/seed";
import { and, eq } from "drizzle-orm";
import type { Account, Profile, User } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identityEvents, userBindings, users } from "@/shared/db/schema";

// --- Mocks (must precede imports of modules under test) ---
// vi.mock factories are hoisted — no top-level variable references allowed inside them.

// Control link intent per test via vi.hoisted
const { mockGetStore } = vi.hoisted(() => ({
  mockGetStore: vi.fn().mockReturnValue(null),
}));

vi.mock(import("@cogni/node-shared"), async (importOriginal) => ({
  ...(await importOriginal()),
  linkIntentStore: { getStore: mockGetStore },
}));

// Stub getCsrfToken (imported at module level by auth.ts, not used in OAuth path)
vi.mock("next-auth/react", () => ({
  getCsrfToken: vi.fn(),
}));

// Stub logger to prevent env validation at module load
vi.mock("@/shared/observability", () => {
  const noop = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  });
  return { makeLogger: noop, makeNoopLogger: noop };
});

// Now import the module under test
import { authOptions } from "@/auth";

// biome-ignore lint/style/noNonNullAssertion: test setup — callbacks and signIn are always defined in authOptions
const signIn = authOptions.callbacks!.signIn!;

// --- Helpers ---

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeOAuthAccount(
  provider: string,
  providerAccountId: string
): Account {
  return { provider, type: "oauth", providerAccountId } as Account;
}

function makeOAuthProfile(login: string, name?: string): Profile {
  return { login, name: name ?? login } as unknown as Profile;
}

/** Call signIn and return { result, userId } */
async function callSignInWithUser(args: {
  account: Account;
  profile?: Profile;
}): Promise<{ result: string | boolean; userId: string }> {
  const user = { id: "" } as User;
  const result = await signIn({
    user,
    account: args.account,
    profile: args.profile,
    credentials: undefined,
    email: undefined,
  });
  return { result, userId: user.id };
}

// --- Tests ---

describe("OAuth signIn callback — DB paths", () => {
  const db = getSeedDb();

  afterEach(() => {
    mockGetStore.mockReturnValue(null);
  });

  it("creates new user with atomic user+binding+event rows", async () => {
    const providerAccountId = "gh-111";

    const { result, userId } = await callSignInWithUser({
      account: makeOAuthAccount("github", providerAccountId),
      profile: makeOAuthProfile("testuser", "Test User"),
    });

    expect(result).toBe(true);
    expect(userId).toMatch(UUID_RE);

    // Verify user row
    const userRow = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    expect(userRow).toBeDefined();
    expect(userRow?.walletAddress).toBeNull();
    expect(userRow?.name).toBe("Test User");

    // Verify binding row
    const binding = await db.query.userBindings.findFirst({
      where: and(
        eq(userBindings.provider, "github"),
        eq(userBindings.externalId, providerAccountId)
      ),
    });
    expect(binding).toBeDefined();
    expect(binding?.userId).toBe(userId);

    // Verify identity event
    const event = await db.query.identityEvents.findFirst({
      where: and(
        eq(identityEvents.userId, userId),
        eq(identityEvents.eventType, "bind")
      ),
    });
    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({
      provider: "github",
      external_id: providerAccountId,
      method: "oauth",
      login: "testuser",
    });

    // All three share the same userId FK
    expect(binding?.userId).toBe(userRow?.id);
    expect(event?.userId).toBe(userRow?.id);
  });

  it("resolves returning user via existing binding", async () => {
    const providerAccountId = "gh-222";

    // Seed user + binding
    await seedUser(db, { id: TEST_USER_ID_1 });
    await db.insert(userBindings).values({
      id: randomUUID(),
      userId: TEST_USER_ID_1,
      provider: "github",
      externalId: providerAccountId,
    });

    // Count rows before
    const bindingsBefore = await db.query.userBindings.findMany({
      where: eq(userBindings.userId, TEST_USER_ID_1),
    });
    const eventsBefore = await db.query.identityEvents.findMany({
      where: eq(identityEvents.userId, TEST_USER_ID_1),
    });

    const { result, userId } = await callSignInWithUser({
      account: makeOAuthAccount("github", providerAccountId),
    });

    expect(result).toBe(true);
    expect(userId).toBe(TEST_USER_ID_1);

    // No new rows created
    const bindingsAfter = await db.query.userBindings.findMany({
      where: eq(userBindings.userId, TEST_USER_ID_1),
    });
    const eventsAfter = await db.query.identityEvents.findMany({
      where: eq(identityEvents.userId, TEST_USER_ID_1),
    });
    expect(bindingsAfter.length).toBe(bindingsBefore.length);
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it("binds to existing user via link intent", async () => {
    const providerAccountId = "gh-333";

    // Seed user with wallet
    await seedUser(db, {
      id: TEST_USER_ID_2,
      walletAddress: TEST_WALLET_2,
    });

    // Seed link transaction + mock pending intent
    const txId = await seedLinkTransaction(db, {
      userId: TEST_USER_ID_2,
      provider: "github",
    });
    mockGetStore.mockReturnValue({ txId, userId: TEST_USER_ID_2 });

    const { result, userId } = await callSignInWithUser({
      account: makeOAuthAccount("github", providerAccountId),
      profile: makeOAuthProfile("linker"),
    });

    expect(result).toBe(true);
    expect(userId).toBe(TEST_USER_ID_2);

    // Verify new binding was created pointing to seeded user
    const binding = await db.query.userBindings.findFirst({
      where: and(
        eq(userBindings.provider, "github"),
        eq(userBindings.externalId, providerAccountId)
      ),
    });
    expect(binding).toBeDefined();
    expect(binding?.userId).toBe(TEST_USER_ID_2);
  });

  it("is idempotent when link intent matches existing binding", async () => {
    const providerAccountId = "gh-444";

    // Seed user + binding
    await seedUser(db, { id: TEST_USER_ID_3 });
    await db.insert(userBindings).values({
      id: randomUUID(),
      userId: TEST_USER_ID_3,
      provider: "github",
      externalId: providerAccountId,
    });

    // Seed link transaction + mock pending intent pointing to same user
    const txId = await seedLinkTransaction(db, {
      userId: TEST_USER_ID_3,
      provider: "github",
    });
    mockGetStore.mockReturnValue({ txId, userId: TEST_USER_ID_3 });

    // Count bindings before
    const bindingsBefore = await db.query.userBindings.findMany({
      where: eq(userBindings.userId, TEST_USER_ID_3),
    });

    const { result, userId } = await callSignInWithUser({
      account: makeOAuthAccount("github", providerAccountId),
    });

    expect(result).toBe(true);
    expect(userId).toBe(TEST_USER_ID_3);

    // No new binding rows
    const bindingsAfter = await db.query.userBindings.findMany({
      where: eq(userBindings.userId, TEST_USER_ID_3),
    });
    expect(bindingsAfter.length).toBe(bindingsBefore.length);
  });

  it("rejects link intent when binding owned by different user (NO_AUTO_MERGE)", async () => {
    const providerAccountId = "gh-555";

    // Seed user A with binding
    await seedUser(db, { id: TEST_USER_ID_4 });
    await db.insert(userBindings).values({
      id: randomUUID(),
      userId: TEST_USER_ID_4,
      provider: "github",
      externalId: providerAccountId,
    });

    // Seed user B
    await seedUser(db, { id: TEST_USER_ID_5 });

    // Seed link transaction for user B + mock pending intent
    const txId = await seedLinkTransaction(db, {
      userId: TEST_USER_ID_5,
      provider: "github",
    });
    mockGetStore.mockReturnValue({ txId, userId: TEST_USER_ID_5 });

    const { result } = await callSignInWithUser({
      account: makeOAuthAccount("github", providerAccountId),
    });

    // Must reject — user B cannot claim user A's binding
    expect(result).toBe("/profile?error=already_linked");

    // Binding still owned by user A
    const binding = await db.query.userBindings.findFirst({
      where: and(
        eq(userBindings.provider, "github"),
        eq(userBindings.externalId, providerAccountId)
      ),
    });
    expect(binding?.userId).toBe(TEST_USER_ID_4);
  });

  // --- Fail-closed link transaction tests ---

  it("rejects when link intent has failed status", async () => {
    // Simulate a failed intent (e.g., JWT decode error in [...nextauth] route)
    mockGetStore.mockReturnValue({ failed: true, reason: "invalid_jwt" });

    const { result } = await callSignInWithUser({
      account: makeOAuthAccount("github", "gh-failed-intent"),
    });

    expect(result).toBe("/profile?error=link_failed");

    // No user or binding created
    const binding = await db.query.userBindings.findFirst({
      where: eq(userBindings.externalId, "gh-failed-intent"),
    });
    expect(binding).toBeUndefined();
  });

  it("rejects when link transaction is expired", async () => {
    const userId = newTestUserId();
    await seedUser(db, { id: userId });

    // Seed an already-expired transaction
    const txId = await seedLinkTransaction(db, {
      userId,
      provider: "github",
      expiresAt: new Date(Date.now() - 60_000), // expired 1 minute ago
    });
    mockGetStore.mockReturnValue({ txId, userId });

    const { result } = await callSignInWithUser({
      account: makeOAuthAccount("github", "gh-expired-tx"),
    });

    // Atomic consume returns no rows for expired tx → fail-closed
    expect(result).toBe("/profile?error=link_failed");

    // No binding created
    const binding = await db.query.userBindings.findFirst({
      where: eq(userBindings.externalId, "gh-expired-tx"),
    });
    expect(binding).toBeUndefined();
  });

  it("rejects when link transaction provider mismatches callback (cross-provider replay)", async () => {
    const userId = newTestUserId();
    await seedUser(db, { id: userId });

    // Seed a valid transaction for "github"
    const txId = await seedLinkTransaction(db, {
      userId,
      provider: "github",
    });

    // Attempt consume via "discord" callback — must reject
    mockGetStore.mockReturnValue({ txId, userId });
    const { result } = await callSignInWithUser({
      account: makeOAuthAccount("discord", "dc-cross-provider"),
    });

    expect(result).toBe("/profile?error=link_failed");

    // No binding created
    const binding = await db.query.userBindings.findFirst({
      where: eq(userBindings.externalId, "dc-cross-provider"),
    });
    expect(binding).toBeUndefined();
  });

  it("rejects when link transaction is already consumed (double-consume)", async () => {
    const userId = newTestUserId();
    const providerAccountId = "gh-double-consume";
    await seedUser(db, { id: userId });

    // Seed a valid transaction
    const txId = await seedLinkTransaction(db, {
      userId,
      provider: "github",
    });

    // First consume — should succeed
    mockGetStore.mockReturnValue({ txId, userId });
    const first = await callSignInWithUser({
      account: makeOAuthAccount("github", providerAccountId),
      profile: makeOAuthProfile("first-link"),
    });
    expect(first.result).toBe(true);

    // Second consume with same txId — must reject
    // Need a different externalId so it's not found via binding lookup
    mockGetStore.mockReturnValue({ txId, userId });
    const second = await callSignInWithUser({
      account: makeOAuthAccount("github", "gh-double-consume-2"),
    });
    expect(second.result).toBe("/profile?error=link_failed");
  });
});
