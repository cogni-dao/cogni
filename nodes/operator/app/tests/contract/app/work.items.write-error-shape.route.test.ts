// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/work.items.write-error-shape.route`
 * Purpose: Prove the work-item write routes answer a PERMANENT refusal and a RETRYABLE outage with different, coded HTTP responses (bug.5408).
 * Scope: Drives the real POST/PATCH handlers with a faked store that throws the adapter's error names; does not touch a network or a database.
 * Invariants:
 *   - AUTHZ_IS_403: `WorkItemAuthorizationError` → 403 `errorCode:"authz_denied"` (same vocabulary as POST /api/v1/vcs/merge).
 *   - BUSY_IS_503: `WorkItemsBusyError` → 503 `errorCode:"work_items_busy"` + retry hint, on PATCH and on create.
 *   - UNKNOWN_STAYS_500: any other store error still answers an opaque 500 — the catch was not broadened.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/work/items/_errors.ts, bug.5408
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as byIdHandler from "@/app/api/v1/work/items/[id]/route";
import * as createHandler from "@/app/api/v1/work/items/route";

// Hoisted so the vi.mock factory (which runs before module init) can close over them.
const { patchMock, createMock, logWarn, logError } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  createMock: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: vi.fn(),
    error: logError,
    warn: logWarn,
    debug: vi.fn(),
  };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-10-09T00:00:00Z")) },
      // respond_500 (the production policy) so the unmapped case can be
      // asserted as a real 500 response instead of a rethrow.
      config: { unhandledErrorPolicy: "respond_500" },
      workItemQuery: { list: vi.fn(), get: vi.fn() },
      doltgresWorkItems: {
        list: vi.fn(),
        get: vi.fn(),
        create: createMock,
        patch: patchMock,
        delete: vi.fn(),
      },
    })),
  };
});

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

/** Reproduce an adapter throw by its stable `name` (the facade detects by name). */
function storeError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const PATCH_BODY = JSON.stringify({ set: { status: "needs_closeout" } });

describe("work-item write error shape (bug.5408)", () => {
  beforeEach(() => {
    patchMock.mockReset();
    createMock.mockReset();
    logWarn.mockReset();
    logError.mockReset();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
  });

  it("maps an author-scoped refusal to 403 authz_denied, not 500", async () => {
    patchMock.mockRejectedValue(
      storeError(
        "WorkItemAuthorizationError",
        "Not authorized to mutate work item: bug.5117"
      )
    );
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "bug.5117" },
      async test({ fetch }) {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: PATCH_BODY,
        });
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.errorCode).toBe("authz_denied");
        expect(json.error).toBe("not authorized");
        // A denial never narrates the row it protected.
        expect(JSON.stringify(json)).not.toContain("bug.5117");
        // Permanent → no retry hint.
        expect(json.retryable).toBeUndefined();
      },
    });
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "authz_denied" }),
      expect.any(String)
    );
  });

  it("maps a store outage to 503 work_items_busy with a retry hint, not 500", async () => {
    patchMock.mockRejectedValue(
      storeError(
        "WorkItemsBusyError",
        "Work-item store timed out during sql.other; retry shortly"
      )
    );
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "bug.5117" },
      async test({ fetch }) {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: PATCH_BODY,
        });
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("2");
        const json = await res.json();
        expect(json.errorCode).toBe("work_items_busy");
        expect(json.retryable).toBe(true);
        expect(json.retryAfterSeconds).toBe(2);
      },
    });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "work_items_busy" }),
      expect.any(String)
    );
  });

  it("maps a store outage on create to the same 503 work_items_busy", async () => {
    createMock.mockRejectedValue(
      storeError(
        "WorkItemsBusyError",
        "Work-item store timed out during sql.other; retry shortly"
      )
    );
    await testApiHandler({
      appHandler: createHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "bug", title: "retryable create" }),
        });
        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json.errorCode).toBe("work_items_busy");
        expect(json.retryable).toBe(true);
      },
    });
  });

  it("leaves every other store error as an opaque 500 (catch not broadened)", async () => {
    patchMock.mockRejectedValue(
      storeError(
        "DoltCommitFailedError",
        "Dolt work-item commit did not return a commit hash"
      )
    );
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "bug.5117" },
      async test({ fetch }) {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: PATCH_BODY,
        });
        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json).toEqual({ error: "Internal server error" });
        expect(json.errorCode).toBeUndefined();
      },
    });
  });
});
