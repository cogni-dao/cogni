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

import { fetchWorkItem } from "./fetchWorkItems";

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

  it("surfaces unknown IDs as errors for the human not-found state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "Work item not found: bug.9999" }),
      })
    );

    await expect(fetchWorkItem("bug.9999")).rejects.toThrow(
      "Work item not found: bug.9999"
    );
  });
});
