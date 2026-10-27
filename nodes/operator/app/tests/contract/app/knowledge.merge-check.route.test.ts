// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/knowledge.merge-check.route`
 * Purpose: Prove the authenticated explicit diagnostic accepts no caller-selected SQL or refs.
 * Scope: Real HTTP route with an injected service. Does not prove native SQL execution.
 * Invariants: Anonymous requests never start work; merge authority is unchanged; unknown never becomes clean.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/spike.5016
 * @internal
 */
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as session from "@/app/_lib/auth/session";
import * as route from "@/app/api/v1/knowledge/contributions/[id]/merge-check/route";

const h = vi.hoisted(() => ({
  preview: vi.fn(),
  merge: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: h.info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getContainer: () => ({
      log,
      clock: { now: () => new Date("2026-10-27T00:00:00Z") },
      config: { unhandledErrorPolicy: "respond_500" },
      knowledgeContributionService: { previewMerge: h.preview, merge: h.merge },
    }),
  };
});
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));

const unknown = {
  contributionId: "contrib-test",
  status: "unavailable",
  mainCommit: null,
  contributionCommit: null,
  checkedAt: "2026-10-27T00:00:00.000Z",
  reason: "native_unavailable",
  conflicts: [],
};
beforeEach(() => {
  h.preview.mockReset().mockResolvedValue(unknown);
  h.merge.mockReset();
  h.info.mockReset();
  vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
});

describe("native merge-check HTTP contract", () => {
  it("rejects anonymous requests before native work", async () => {
    vi.mocked(session.getSessionUser).mockResolvedValue(null);
    await testApiHandler({
      appHandler: route,
      params: { id: "contrib-test" },
      async test({ fetch }) {
        expect((await fetch({ method: "POST", body: "{}" })).status).toBe(401);
        expect(h.preview).not.toHaveBeenCalled();
      },
    });
  });
  it("accepts an authenticated read and preserves an unavailable verdict", async () => {
    await testApiHandler({
      appHandler: route,
      params: { id: "contrib-test" },
      async test({ fetch }) {
        const response = await fetch({ method: "POST", body: "{}" });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual(unknown);
        expect(h.preview).toHaveBeenCalledWith("contrib-test");
        expect(h.merge).not.toHaveBeenCalled();
      },
    });
  });
  it.each([
    { sql: "SELECT 1" },
    { mainCommit: "caller-ref" },
    { table: "knowledge" },
  ])("rejects caller-selected inputs %#", async (input) => {
    await testApiHandler({
      appHandler: route,
      params: { id: "contrib-test" },
      async test({ fetch }) {
        expect(
          (await fetch({ method: "POST", body: JSON.stringify(input) })).status
        ).toBe(400);
        expect(h.preview).not.toHaveBeenCalled();
      },
    });
  });
});
