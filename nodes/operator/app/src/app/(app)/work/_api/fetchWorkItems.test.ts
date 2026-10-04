// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems.test`
 * Purpose: Covers the exact-item cookie-auth fetch used by human permalinks.
 * Scope: Browser fetch contract only.
 * Side-effects: mocked fetch
 * Links: bug.5355, ./fetchWorkItems.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWorkItem, WorkItemFetchError } from "./fetchWorkItems";

describe("fetchWorkItem", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the exact encoded work-item endpoint with same-origin auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "bug.5355" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkItem("bug.5355")).resolves.toMatchObject({
      id: "bug.5355",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items/bug.5355",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" })
    );
  });

  it("encodes a literal percent exactly once at the machine API boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "bug.%25" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkItem("bug.%25");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items/bug.%2525",
      expect.any(Object)
    );
  });

  it.each([
    { status: 404, kind: "not_found" },
    { status: 401, kind: "auth" },
    { status: 403, kind: "auth" },
    { status: 409, kind: "busy" },
    { status: 429, kind: "busy" },
    { status: 503, kind: "busy" },
    { status: 500, kind: "server" },
    { status: 502, kind: "server" },
    { status: 400, kind: "unexpected" },
  ] as const)("classifies HTTP $status as $kind", async ({ status, kind }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: () => Promise.resolve({ error: `HTTP ${status}` }),
      })
    );

    const error = await fetchWorkItem("bug.9999").catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(WorkItemFetchError);
    expect(error).toMatchObject({ kind, status });
  });

  it("classifies a rejected fetch as a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const error = await fetchWorkItem("bug.5355").catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(WorkItemFetchError);
    expect(error).toMatchObject({ kind: "network" });
  });
});
