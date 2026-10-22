// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_api/fetchWorkItems.test`
 * Purpose: Covers the lean progressive list-page fetch, the bounded (timeout) fetch, and the exact-item cookie-auth fetch used by human permalinks.
 * Scope: Browser fetch contract only.
 * Side-effects: mocked fetch
 * Links: bug.5355, bug.5509, ./fetchWorkItems.ts
 */

import type { WorkItemDto, WorkItemsListOutput } from "@cogni/node-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWorkItem,
  fetchWorkItemsPage,
  flattenWorkItemPages,
  MAX_WORK_ITEM_PAGES,
  nextWorkItemsCursor,
  WorkItemFetchError,
} from "./fetchWorkItems";

function item(id: string, title = id): WorkItemDto {
  return {
    id,
    type: "task",
    title,
    status: "needs_implement",
    assignees: [],
    externalRefs: [],
    labels: [],
    specRefs: [],
    revision: 0,
    deployVerified: false,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
  };
}

function page(
  items: WorkItemDto[],
  endCursor: string | null,
  hasMore: boolean
): WorkItemsListOutput {
  return { items, pageInfo: { endCursor, hasMore } };
}

describe("fetchWorkItemsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the lean first page without a cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(page([item("task.1")], "c1", true)),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkItemsPage(null)).resolves.toMatchObject({
      items: [{ id: "task.1" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items?limit=500&view=lean",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" })
    );
  });

  it("passes the cursor for later pages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(page([], null, false)),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkItemsPage("abc");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items?limit=500&view=lean&cursor=abc",
      expect.any(Object)
    );
  });

  it("throws the server error message on a failed page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "boom" }),
      })
    );

    await expect(fetchWorkItemsPage(null)).rejects.toThrow("boom");
  });
});

describe("bounded fetch (BOUNDED_FETCH)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Settles only when the request signal aborts, like a stalled socket. */
  function untilAborted(signal: AbortSignal | null | undefined) {
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  }

  /** Resolves headers immediately, then stalls the body until aborted. */
  function stalledBodyFetch() {
    return vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve({ ok: true, json: () => untilAborted(init.signal) })
    );
  }

  it("rejects a stalled list body with a retryable timeout error", async () => {
    vi.stubGlobal("fetch", stalledBodyFetch());

    const error = await fetchWorkItemsPage(null, { timeoutMs: 20 }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(WorkItemFetchError);
    expect(error).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("rejects a stalled exact-item request with a retryable timeout error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => untilAborted(init.signal))
    );

    const error = await fetchWorkItem("bug.5509", { timeoutMs: 20 }).catch(
      (caught: unknown) => caught
    );

    expect(error).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("passes caller cancellation through instead of reporting a timeout", async () => {
    vi.stubGlobal("fetch", stalledBodyFetch());
    const caller = new AbortController();

    const pending = fetchWorkItemsPage(null, {
      signal: caller.signal,
      timeoutMs: 10_000,
    }).catch((caught: unknown) => caught);
    caller.abort();
    const error = await pending;

    expect(error).not.toBeInstanceOf(WorkItemFetchError);
    expect(error).toMatchObject({ name: "AbortError" });
  });

  it("does not mark not-found as retryable", () => {
    expect(new WorkItemFetchError("not_found", "gone", 404).retryable).toBe(
      false
    );
  });
});

describe("nextWorkItemsCursor", () => {
  it("returns the end cursor while more pages exist", () => {
    const first = page([item("task.1")], "c1", true);
    expect(nextWorkItemsCursor(first, [first])).toBe("c1");
  });

  it("stops when the server reports no more pages", () => {
    const last = page([item("task.1")], null, false);
    expect(nextWorkItemsCursor(last, [last])).toBeUndefined();
  });

  it("stops at the page cap even if the server says hasMore", () => {
    const p = page([item("task.1")], "cN", true);
    const pages = Array.from({ length: MAX_WORK_ITEM_PAGES }, () => p);
    expect(nextWorkItemsCursor(p, pages)).toBeUndefined();
  });
});

describe("flattenWorkItemPages", () => {
  it("concatenates pages and lets a later row replace an earlier duplicate in place", () => {
    const pages = [
      page([item("task.1"), item("bug.0002", "markdown")], "c1", true),
      page([item("task.3"), item("bug.0002", "doltgres")], null, false),
    ];

    const flat = flattenWorkItemPages(pages);

    expect(flat.map((i) => i.id)).toEqual(["task.1", "bug.0002", "task.3"]);
    expect(flat[1]?.title).toBe("doltgres");
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
