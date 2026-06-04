// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/auth/profile-isolation.stack`
 * Purpose: Verify profile API enforces per-user isolation — user A cannot read or update user B's profile.
 * Scope: Tests GET/PATCH /api/v1/users/me with two distinct session mocks. Uses real DB. Does not test SIWE or OAuth flows.
 * Invariants: Profile reads/writes are scoped to the authenticated user's ID; no cross-user data leakage.
 * Side-effects: IO (database writes via seed client)
 * Notes: Mocks @/lib/auth/server to swap session identity between requests.
 * Links: src/app/api/v1/users/me/route.ts, src/app/_facades/users/profile.server.ts
 * @internal
 */

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: vi.fn(),
}));

import type { SessionUser } from "@cogni/node-shared";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { GET, PATCH } from "@/app/api/v1/users/me/route";
import { getServerSessionUser } from "@/lib/auth/server";
import { users } from "@/shared/db/schema";

describe("Profile Isolation Stack Test", () => {
  const userA: SessionUser = {
    id: randomUUID(),
    walletAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    displayName: null,
    avatarColor: null,
  };

  const userB: SessionUser = {
    id: randomUUID(),
    walletAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    displayName: null,
    avatarColor: null,
  };

  beforeAll(async () => {
    if (process.env.APP_ENV !== "test") {
      throw new Error("This test must run in APP_ENV=test");
    }

    const db = getSeedDb();
    await db.insert(users).values([
      { id: userA.id, walletAddress: userA.walletAddress },
      { id: userB.id, walletAddress: userB.walletAddress },
    ]);
  });

  it("user A sets a profile, user B reads their own — no cross-user leakage", async () => {
    // User A updates their profile
    vi.mocked(getServerSessionUser).mockResolvedValue(userA);

    const patchReq = new NextRequest("http://localhost:3000/api/v1/users/me", {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "Alice",
        avatarColor: "#ff0000",
      }),
    });
    const patchRes = await PATCH(patchReq);
    expect(patchRes.status).toBe(200);

    const patchJson = await patchRes.json();
    expect(patchJson.displayName).toBe("Alice");
    expect(patchJson.avatarColor).toBe("#ff0000");

    // User B reads their own profile — should NOT see Alice's data
    vi.mocked(getServerSessionUser).mockResolvedValue(userB);

    const getReq = new NextRequest("http://localhost:3000/api/v1/users/me", {
      method: "GET",
    });
    const getRes = await GET(getReq);
    expect(getRes.status).toBe(200);

    const getJson = await getRes.json();
    expect(getJson.displayName).toBeNull();
    expect(getJson.avatarColor).toBeNull();
    expect(getJson.resolvedDisplayName).not.toBe("Alice");
  });

  it("unauthenticated request returns 401", async () => {
    vi.mocked(getServerSessionUser).mockResolvedValue(null);

    const req = new NextRequest("http://localhost:3000/api/v1/users/me", {
      method: "GET",
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("PATCH validates avatarColor format", async () => {
    vi.mocked(getServerSessionUser).mockResolvedValue(userA);

    const req = new NextRequest("http://localhost:3000/api/v1/users/me", {
      method: "PATCH",
      body: JSON.stringify({ avatarColor: "not-a-hex" }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("PATCH validates displayName length", async () => {
    vi.mocked(getServerSessionUser).mockResolvedValue(userA);

    const req = new NextRequest("http://localhost:3000/api/v1/users/me", {
      method: "PATCH",
      body: JSON.stringify({ displayName: "a".repeat(51) }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });
});
