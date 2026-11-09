// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/auth/nextauth-route-session-context`
 * Purpose: bug.5603 — the NextAuth route exposes an existing session to the signIn callback on
 *   callback routes only, so an OAuth callback can detect "already signed in".
 * Scope: Mocks NextAuth and token decoding; asserts the request-scoped store contents.
 * Side-effects: none
 * Links: src/app/api/auth/[...nextauth]/route.ts
 * @internal
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ value: undefined as unknown }));
const getToken = vi.hoisted(() => vi.fn());

vi.mock("next-auth", () => ({
  default: () => async () => {
    const { signedInSessionStore: store } = await import(
      "@/shared/identity/signed-in-session-store"
    );
    seen.value = store.getStore();
    return new Response(null, { status: 302 });
  },
}));
vi.mock("next-auth/jwt", () => ({ decode: vi.fn(), getToken }));
vi.mock("@/auth", () => ({ authOptions: {}, authSecret: "test-secret" }));

import { GET } from "@/app/api/auth/[...nextauth]/route";

const call = (nextauth: string[]) =>
  GET(new NextRequest(`http://localhost:3000/api/auth/${nextauth.join("/")}`), {
    params: Promise.resolve({ nextauth }),
  });

describe("NextAuth route — signed-in session context", () => {
  beforeEach(() => {
    seen.value = undefined;
    getToken.mockReset();
  });

  it("exposes the existing session user on callback routes", async () => {
    getToken.mockResolvedValue({ id: "user-1" });
    await call(["callback", "github"]);
    expect(seen.value).toEqual({ userId: "user-1" });
  });

  it("is null for a signed-out callback", async () => {
    getToken.mockResolvedValue(null);
    await call(["callback", "github"]);
    expect(seen.value).toBeNull();
  });

  it("fails closed: a session token without an id still counts as a session", async () => {
    getToken.mockResolvedValue({});
    await call(["callback", "github"]);
    expect(seen.value).toEqual({ userId: "" });
  });

  it("does not read the session on non-callback routes", async () => {
    await call(["session"]);
    expect(getToken).not.toHaveBeenCalled();
    expect(seen.value).toBeNull();
  });
});
