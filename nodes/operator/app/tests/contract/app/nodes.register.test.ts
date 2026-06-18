// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.register`
 * Purpose: Contract tests for registering first-class nodes (operator / node-template) as owned rows.
 * Scope: Verifies POST /api/v1/nodes/register requires a session, accepts only first-class slugs,
 *   inserts with the caller as owner + correct repo coords, and is idempotent.
 * Invariants: AUTH_REQUIRED, FIRST_CLASS_ONLY, IDEMPOTENT.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/nodes/register/route.ts, story.5009
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  inserted: null as { id: string; slug: string } | null,
  existing: null as { id: string; slug: string } | null,
}));
const insertValues = vi.hoisted(() => vi.fn());
const mockGetServerSessionUser = vi.hoisted(() => vi.fn());

const mockTx = {
  insert: () => ({
    values: (v: unknown) => {
      insertValues(v);
      return {
        onConflictDoNothing: () => ({
          returning: () => (dbState.inserted ? [dbState.inserted] : []),
        }),
      };
    },
  }),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => (dbState.existing ? [dbState.existing] : []),
      }),
    }),
  }),
};

vi.mock("@/bootstrap/container", () => ({
  resolveAppDb: () => ({}),
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: () => mockGetServerSessionUser(),
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: unknown) => unknown
  ) => run(mockTx),
}));

import * as appHandler from "@/app/api/v1/nodes/register/route";

interface RegisterBody {
  node?: { slug?: string };
  alreadyRegistered?: boolean;
  error?: string;
}

async function register(
  slug: unknown
): Promise<{ status: number; body: RegisterBody }> {
  let out: { status: number; body: RegisterBody } = { status: 0, body: {} };
  await testApiHandler({
    appHandler,
    async test({ fetch }) {
      const res = await fetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      out = { status: res.status, body: (await res.json()) as RegisterBody };
    },
  });
  return out;
}

describe("POST /api/v1/nodes/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    dbState.inserted = {
      id: "44444444-4444-4444-8444-444444444444",
      slug: "operator",
    };
    dbState.existing = null;
  });

  it("registers operator as a row owned by the caller with hub repo coords", async () => {
    const res = await register("operator");
    expect(res.status).toBe(201);
    expect(res.body.node?.slug).toBe("operator");
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "operator",
        repoOwner: "cogni-dao",
        repoName: "cogni",
        ownerUserId: TEST_SESSION_USER_1.id,
        status: "active",
      })
    );
  });

  it("registers node-template with its own repo coords", async () => {
    dbState.inserted = {
      id: "55555555-5555-4555-8555-555555555555",
      slug: "node-template",
    };
    const res = await register("node-template");
    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "node-template", repoName: "node-template" })
    );
  });

  it("rejects a non-first-class slug without inserting", async () => {
    const res = await register("my-wizard-node");
    expect(res.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    mockGetServerSessionUser.mockResolvedValue(null);
    const res = await register("operator");
    expect(res.status).toBe(401);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("is idempotent — returns the existing row when already registered", async () => {
    dbState.inserted = null;
    dbState.existing = {
      id: "44444444-4444-4444-8444-444444444444",
      slug: "operator",
    };
    const res = await register("operator");
    expect(res.status).toBe(200);
    expect(res.body.alreadyRegistered).toBe(true);
  });
});
