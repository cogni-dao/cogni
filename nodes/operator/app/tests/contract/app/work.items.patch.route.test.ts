// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/work.items.patch.route`
 * Purpose: Route-level contract tests for PATCH /api/v1/work/items/:id — POST the
 *   contract-shaped body against the real handler so route↔contract can't silently
 *   drift (bug.5242).
 * Scope: Exercises the actual PATCH handler through next-test-api-route-handler with
 *   a mocked container + session. No DB.
 * Invariants:
 *   - CONTRACT_WRAPPER_IS_SET: the canonical `{ set: {...} }` body reaches the adapter
 *     with `{ id, set }` and returns 200 — the route parses the vendored contract's
 *     input directly, so this proves they agree end-to-end.
 *   - WRONG_WRAPPER_400: `{ patch: {...} }` (the recurring guess from the op name)
 *     is rejected with the bad key surfaced — not a silent-ignore.
 *   - AUTH_REQUIRED: 401 when no session.
 * Side-effects: none
 * Links: bug.5242, packages/node-contracts/src/work.items.patch.v1.contract.ts,
 *   nodes/operator/app/src/app/api/v1/work/items/[id]/route.ts
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as appHandler from "@/app/api/v1/work/items/[id]/route";

const patchMock = vi.fn();

vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-05-05T00:00:00Z")) },
      config: { unhandledErrorPolicy: "rethrow" },
      workItemQuery: { list: vi.fn(), get: vi.fn() },
      doltgresWorkItems: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        patch: patchMock,
        delete: vi.fn(),
      },
    })),
  };
});

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

// Minimal domain WorkItem the adapter would return; `actor: "either"` keeps
// toDto from spreading an actor key it doesn't need.
const PATCHED_ITEM = {
  id: "bug.5242",
  type: "bug",
  title: "contract wrapper",
  status: "needs_closeout",
  actor: "either",
  node: "operator",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 1,
  deployVerified: false,
  createdAt: "2026-05-05T00:00:00.000Z",
  updatedAt: "2026-05-05T00:00:00.000Z",
};

describe("PATCH /api/v1/work/items/:id", () => {
  beforeEach(() => {
    patchMock.mockReset();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
  });

  it("accepts the contract-shaped { set } body and forwards { id, set } to the adapter", async () => {
    patchMock.mockResolvedValue(PATCHED_ITEM);
    await testApiHandler({
      appHandler,
      params: { id: "bug.5242" },
      async test({ fetch }) {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ set: { status: "needs_closeout" } }),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.id).toBe("bug.5242");
        expect(json.status).toBe("needs_closeout");
      },
    });
    expect(patchMock).toHaveBeenCalledOnce();
    const [arg] = patchMock.mock.calls[0];
    expect(arg.id).toBe("bug.5242");
    expect(arg.set).toEqual({ status: "needs_closeout" });
  });

  it("rejects the wrong { patch } wrapper with 400 and surfaces the bad key (bug.5242)", async () => {
    await testApiHandler({
      appHandler,
      params: { id: "bug.5242" },
      async test({ fetch }) {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch: { status: "needs_closeout" } }),
        });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toBe("invalid input");
        expect(JSON.stringify(json.issues)).toContain("patch");
      },
    });
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(session.getSessionUser).mockResolvedValue(null);
    await testApiHandler({
      appHandler,
      params: { id: "bug.5242" },
      async test({ fetch }) {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ set: { status: "needs_closeout" } }),
        });
        expect(res.status).toBe(401);
      },
    });
  });
});
