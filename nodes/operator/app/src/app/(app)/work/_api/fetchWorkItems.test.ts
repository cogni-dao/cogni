// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems.test`
 * Purpose: Covers the exact-item cookie-auth fetch used by human permalinks and the bounded summary/board fetchers (task.0056).
 * Scope: Browser fetch contract only.
 * Side-effects: mocked fetch
 * Links: bug.5355, ./fetchWorkItems.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWorkBoard,
  fetchWorkItem,
  fetchWorkItems,
  WorkItemFetchError,
} from "./fetchWorkItems";

describe("bounded list fetchers (task.0056)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetchWorkItems makes exactly one summaries request with the caller's params and signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [],
          pageInfo: { endCursor: "next", hasMore: true },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const page = await fetchWorkItems(
      new URLSearchParams({ limit: "25", statuses: "done" }),
      controller.signal
    );

    expect(page.pageInfo).toEqual({ endCursor: "next", hasMore: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/summaries?limit=25&statuses=done",
      expect.objectContaining({
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
      })
    );
  });

  it("fetchWorkBoard makes exactly one board request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ columns: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkBoard(new URLSearchParams({ statuses: "done,needs_merge" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/work/board?statuses=done%2Cneeds_merge"
    );
  });

  it("rejects with the HTTP status so the package hooks skip 4xx retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "invalid input" }),
      })
    );

    const error = await fetchWorkItems(new URLSearchParams("limit=500")).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(WorkItemFetchError);
    expect(error).toMatchObject({ status: 400, message: "invalid input" });
  });
});

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
