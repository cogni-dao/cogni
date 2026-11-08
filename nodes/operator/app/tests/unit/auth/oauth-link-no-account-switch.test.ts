// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/auth/oauth-link-no-account-switch`
 * Purpose: bug.5603 — an OAuth callback can never switch the signed-in account, and the
 *   server (not the client callbackUrl) decides the link outcome.
 * Scope: Drives the real `signIn` callback with a mocked service DB and the request-scoped
 *   stores. Does not test NextAuth internals or the DB.
 * Invariants: SESSION_NEVER_SWITCHED_BY_OAUTH_CALLBACK; signed-out sign-in unchanged;
 *   link success returns a server-decided URL.
 * Side-effects: none
 * Links: src/auth.ts, src/shared/identity/signed-in-session-store.ts
 * @internal
 */

import { linkIntentStore } from "@cogni/node-shared";
import type { Account, User } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = "12d8b127-0000-4000-8000-000000000001";
const GITHUB_OWNER = "25b7768f-0000-4000-8000-000000000002";

const db = vi.hoisted(() => ({
  binding: null as { id: string; userId: string } | null,
  consumedFor: null as string | null,
  update: vi.fn(),
}));
const createBinding = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
  getServiceDb: () => ({
    query: {
      userBindings: { findFirst: async () => db.binding },
      users: { findFirst: async () => ({ walletAddress: "0xabc" }) },
    },
    // consumeLinkTransaction: update().set().where().returning()
    update: (...a: unknown[]) => {
      db.update(...a);
      const chain = {
        set: () => chain,
        where: () => chain,
        returning: async () =>
          db.consumedFor ? [{ userId: db.consumedFor }] : [],
      };
      return chain;
    },
  }),
}));
vi.mock("@/adapters/server/identity/create-binding", () => ({
  createBinding,
}));
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
vi.mock("next-auth/react", () => ({ getCsrfToken: vi.fn() }));

import { authOptions } from "@/auth";
import { signedInSessionStore } from "@/shared/identity/signed-in-session-store";

// biome-ignore lint/style/noNonNullAssertion: signIn is always defined in authOptions
const signIn = authOptions.callbacks!.signIn!;

const github = {
  provider: "github",
  type: "oauth",
  providerAccountId: "gh-1",
} as Account;

function run(opts: {
  session: { userId: string } | null;
  intent: { txId: string; userId: string } | null;
}) {
  const user = { id: "adapter-assigned" } as User;
  const result = signedInSessionStore.run(opts.session, () =>
    linkIntentStore.run(opts.intent, () =>
      signIn({
        user,
        account: github,
        profile: { login: "octo" },
        credentials: undefined,
        email: undefined,
      })
    )
  );
  return { user, result };
}

describe("OAuth callback never switches the signed-in account (bug.5603)", () => {
  beforeEach(() => {
    db.binding = null;
    db.consumedFor = null;
    db.update.mockClear();
    createBinding.mockReset();
  });

  it("(a) existing session + no link intent + binding owned by another user: error redirect, no switch", async () => {
    db.binding = { id: "b1", userId: GITHUB_OWNER };
    const { user, result } = run({
      session: { userId: SESSION_USER },
      intent: null,
    });

    await expect(result).resolves.toBe("/profile?error=link_failed");
    expect(user.id).toBe("adapter-assigned"); // never rewritten to the binding owner
    expect(createBinding).not.toHaveBeenCalled();
  });

  it("(a) existing session + no link intent + unknown external account: no new user minted", async () => {
    const { result } = run({ session: { userId: SESSION_USER }, intent: null });

    await expect(result).resolves.toBe("/profile?error=link_failed");
    expect(createBinding).not.toHaveBeenCalled();
  });

  it("(b) signed-out sign-in as the binding owner is unchanged", async () => {
    db.binding = { id: "b1", userId: GITHUB_OWNER };
    const { user, result } = run({ session: null, intent: null });

    await expect(result).resolves.toBe(true);
    expect(user.id).toBe(GITHUB_OWNER);
  });

  it("(c) verified link intent creating a binding returns the server URL and links to the session user", async () => {
    db.consumedFor = SESSION_USER;
    const { result } = run({
      session: { userId: SESSION_USER },
      intent: { txId: "tx1", userId: SESSION_USER },
    });

    await expect(result).resolves.toBe("/profile?linked=github");
    expect(createBinding).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_USER,
      "github",
      "gh-1",
      expect.objectContaining({ method: "oauth_link" })
    );
  });

  it("(c) idempotent re-link by the same user returns the server URL", async () => {
    db.consumedFor = SESSION_USER;
    db.binding = { id: "b1", userId: SESSION_USER };
    const { result } = run({
      session: { userId: SESSION_USER },
      intent: { txId: "tx1", userId: SESSION_USER },
    });

    await expect(result).resolves.toBe("/profile?linked=github");
    expect(createBinding).not.toHaveBeenCalled();
  });

  it("verified link intent for a binding owned by another user still returns already_linked", async () => {
    db.consumedFor = SESSION_USER;
    db.binding = { id: "b1", userId: GITHUB_OWNER };
    const { result } = run({
      session: { userId: SESSION_USER },
      intent: { txId: "tx1", userId: SESSION_USER },
    });

    await expect(result).resolves.toBe("/profile?error=already_linked");
  });
});
