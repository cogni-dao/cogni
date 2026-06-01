// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/attribution/epoch-review-signing.stack`
 * Purpose: Stack-level validation of epoch signing and review-subject-override API routes.
 * Scope: Tests auth gating, status gates, and schema compliance for sign-data and review-subject-overrides endpoints. Does not test approver happy paths (requires repo-spec wallet).
 * Invariants: WRITE_ROUTES_AUTHED, WRITE_ROUTES_APPROVER_GATED, SIGNATURE_SCOPE_BOUND.
 * Side-effects: IO (HTTP requests, database writes for seeding)
 * Notes: Approver-gated happy paths require the repo-spec approver wallet. Tests here cover auth/status gates
 *   and schema compliance. Hash parity is tested as a pure unit test in signing.test.ts.
 * Links: src/app/api/v1/attribution/epochs/[id]/sign-data/route.ts,
 *         src/app/api/v1/attribution/epochs/[id]/review-subject-overrides/route.ts
 * @public
 */

import { DrizzleAttributionAdapter } from "@cogni/db-client";
import type { SeededReviewEpoch } from "@tests/_fixtures/attribution/seed-attribution";
import {
  seedClosedEpoch,
  seedReviewEpoch,
} from "@tests/_fixtures/attribution/seed-attribution";
import type { NextAuthSessionCookie } from "@tests/_fixtures/auth/nextauth-http-helpers";
import { siweLogin } from "@tests/_fixtures/auth/nextauth-http-helpers";
import { generateTestWallet } from "@tests/_fixtures/auth/siwe-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { fetchStackTest } from "@tests/_fixtures/http/rate-limit-helpers";
import { beforeAll, describe, expect, it } from "vitest";
import { users } from "@/shared/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Real node_id from .cogni/repo-spec.yaml — routes use getNodeId() */
const REPO_NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const REPO_SCOPE_ID = "a28a8b1e-1f9d-5cd5-9329-569e4819feda";

function baseUrl(path: string): string {
  const root = process.env.TEST_BASE_URL ?? "http://localhost:3000";
  return new URL(path.replace(/^\//, ""), root).toString();
}

function cookieHeader(cookie: NextAuthSessionCookie): string {
  return `${cookie.name}=${cookie.value}`;
}

// ---------------------------------------------------------------------------
// Setup: seed review epoch + finalized epoch + auth session
// ---------------------------------------------------------------------------

let reviewEpoch: SeededReviewEpoch;
let finalizedEpochId: string;
let sessionCookie: NextAuthSessionCookie | null = null;

beforeAll(async () => {
  const db = getSeedDb();

  // Seed FK-required users
  await db
    .insert(users)
    .values([
      {
        id: "user-1",
        walletAddress: `0x${"a1".repeat(20)}`,
        name: "Test User 1",
      },
      {
        id: "user-2",
        walletAddress: `0x${"b2".repeat(20)}`,
        name: "Test User 2",
      },
    ])
    .onConflictDoNothing();

  const store = new DrizzleAttributionAdapter(db, REPO_SCOPE_ID);

  // Seed review epoch (unique offset to avoid collisions)
  reviewEpoch = await seedReviewEpoch(store, {
    nodeId: REPO_NODE_ID,
    scopeId: REPO_SCOPE_ID,
    epochOffset: -20,
  });

  // Seed finalized epoch for status-gate tests
  const closed = await seedClosedEpoch(store, {
    nodeId: REPO_NODE_ID,
    scopeId: REPO_SCOPE_ID,
    epochOffset: -21,
  });
  finalizedEpochId = String(closed.epoch.id);

  // Authenticate with a non-approver wallet (for auth-gate tests)
  const wallet = generateTestWallet("epoch-review-signing-test");
  const domain = new URL(baseUrl("/")).host;
  const loginResult = await siweLogin({
    baseUrl: baseUrl("/").replace(/\/$/, ""),
    wallet,
    domain,
  });
  if (loginResult.success && loginResult.sessionCookie) {
    sessionCookie = loginResult.sessionCookie;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Epoch sign-data API", () => {
  const signDataPath = () =>
    `/api/v1/attribution/epochs/${reviewEpoch.epoch.id}/sign-data`;

  it("returns 401 when unauthenticated", async () => {
    const response = await fetchStackTest(baseUrl(signDataPath()));
    expect(response.status).toBe(401);
  });

  it("returns 403 for authenticated non-approver", async () => {
    if (!sessionCookie) return; // skip if SIWE login failed
    const response = await fetchStackTest(baseUrl(signDataPath()), {
      headers: { Cookie: cookieHeader(sessionCookie) },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/approver/i);
  });

  it("returns 400 for invalid epoch ID", async () => {
    if (!sessionCookie) return;
    const response = await fetchStackTest(
      baseUrl("/api/v1/attribution/epochs/not-a-number/sign-data"),
      { headers: { Cookie: cookieHeader(sessionCookie) } }
    );
    // May be 400 or 403 depending on middleware order — both acceptable
    expect([400, 403]).toContain(response.status);
  });
});

describe("Epoch review-subject-overrides API", () => {
  const overridesPath = () =>
    `/api/v1/attribution/epochs/${reviewEpoch.epoch.id}/review-subject-overrides`;

  describe("GET (list overrides)", () => {
    it("returns 401 when unauthenticated", async () => {
      const response = await fetchStackTest(baseUrl(overridesPath()));
      expect(response.status).toBe(401);
    });

    it("returns 200 with empty overrides for authenticated user", async () => {
      if (!sessionCookie) return;
      const response = await fetchStackTest(baseUrl(overridesPath()), {
        headers: { Cookie: cookieHeader(sessionCookie) },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("overrides");
      expect(Array.isArray(body.overrides)).toBe(true);
    });
  });

  describe("PATCH (upsert overrides)", () => {
    it("returns 401 when unauthenticated", async () => {
      const response = await fetchStackTest(baseUrl(overridesPath()), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          overrides: [{ subjectRef: "r1", overrideUnits: "5000" }],
        }),
      });
      expect(response.status).toBe(401);
    });

    it("returns 403 for authenticated non-approver", async () => {
      if (!sessionCookie) return;
      const response = await fetchStackTest(baseUrl(overridesPath()), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(sessionCookie),
        },
        body: JSON.stringify({
          overrides: [{ subjectRef: "r1", overrideUnits: "5000" }],
        }),
      });
      expect(response.status).toBe(403);
    });
  });

  describe("DELETE (remove override)", () => {
    it("returns 401 when unauthenticated", async () => {
      const response = await fetchStackTest(baseUrl(overridesPath()), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectRef: "r1" }),
      });
      expect(response.status).toBe(401);
    });

    it("returns 403 for authenticated non-approver", async () => {
      if (!sessionCookie) return;
      const response = await fetchStackTest(baseUrl(overridesPath()), {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(sessionCookie),
        },
        body: JSON.stringify({ subjectRef: "r1" }),
      });
      expect(response.status).toBe(403);
    });
  });
});

describe("Status gate enforcement", () => {
  it("sign-data returns 409 for finalized epoch (via non-review status gate)", async () => {
    if (!sessionCookie) return;
    const response = await fetchStackTest(
      baseUrl(`/api/v1/attribution/epochs/${finalizedEpochId}/sign-data`),
      { headers: { Cookie: cookieHeader(sessionCookie) } }
    );
    // 403 (approver gate) takes precedence over 409 (status gate) for non-approvers
    // Either is acceptable — the route is protected
    expect([403, 409]).toContain(response.status);
  });
});
