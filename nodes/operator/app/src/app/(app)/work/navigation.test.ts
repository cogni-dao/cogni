// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/navigation.test`
 * Purpose: Focused coverage for route-backed work-item open, close, and browser-history semantics.
 * Scope: Pure navigation helpers; no DOM or network IO.
 * Side-effects: none
 * Links: bug.5355, ./view.tsx
 */

import { describe, expect, it, vi } from "vitest";

import {
  closeWorkItemPermalink,
  openWorkItemPermalink,
  readBoardColumns,
  readWorkFilters,
  readWorkSorting,
  workItemHref,
  workListHref,
  workListStateSearchParams,
  writeWorkListState,
} from "./_lib/workItemNavigation";

const searchParams = new URLSearchParams(
  "status=needs_implement&sort=priority&q=permalink"
);

describe("work-item permalink navigation", () => {
  it("builds exact human routes while preserving useful list state", () => {
    expect(workItemHref("bug.5355", searchParams)).toBe(
      "/work/items/bug.5355?status=needs_implement&sort=priority&q=permalink"
    );
    expect(workListHref(searchParams)).toBe(
      "/work?status=needs_implement&sort=priority&q=permalink"
    );
  });

  it("pushes item selection so browser back returns to the list", () => {
    const router = { push: vi.fn(), replace: vi.fn() };

    openWorkItemPermalink(router, "bug.5355", searchParams);

    expect(router.push).toHaveBeenCalledWith(
      "/work/items/bug.5355?status=needs_implement&sort=priority&q=permalink",
      { scroll: false }
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("replaces a closed sheet with its preserved list URL", () => {
    const router = { push: vi.fn(), replace: vi.fn() };

    closeWorkItemPermalink(router, searchParams);

    expect(router.replace).toHaveBeenCalledWith(
      "/work?status=needs_implement&sort=priority&q=permalink",
      { scroll: false }
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("encodes a literal percent exactly once at the human URL boundary", () => {
    expect(workItemHref("bug.%25", new URLSearchParams())).toBe(
      "/work/items/bug.%2525"
    );
  });

  it("preserves unrelated query keys while clearing removed controlled filters", () => {
    const current = new URLSearchParams(
      "type=bug&status=needs_implement&project=operator&sort=-priority&q=old&rankMin=2&rankMax=4&context=keep"
    );

    const next = workListStateSearchParams(current);
    next.set("sort", "priority");

    expect(next.get("context")).toBe("keep");
    expect(next.get("type")).toBeNull();
    expect(next.get("status")).toBeNull();
    expect(next.get("project")).toBeNull();
    expect(next.get("q")).toBeNull();
    expect(next.get("rankMin")).toBeNull();
    expect(next.get("rankMax")).toBeNull();
    expect(next.get("sort")).toBe("priority");
  });
});

describe("work list URL state", () => {
  it("defaults to active statuses, rank-descending, and every active board column", () => {
    const empty = new URLSearchParams();
    const status = readWorkFilters(empty).find((f) => f.id === "status");
    expect(status?.value).toContain("needs_implement");
    expect(status?.value).not.toContain("done");
    expect(readWorkSorting(empty)).toEqual([{ id: "rankScore", desc: true }]);
    expect(readBoardColumns(empty)).not.toContain("cancelled");
  });

  it("reads status=all as no status filter and rank bounds as a range", () => {
    const filters = readWorkFilters(
      new URLSearchParams("status=all&type=bug,task&rankMin=3")
    );
    expect(filters.find((f) => f.id === "status")).toBeUndefined();
    expect(filters.find((f) => f.id === "type")?.value).toEqual([
      "bug",
      "task",
    ]);
    expect(filters.find((f) => f.id === "rankScore")?.value).toEqual([
      3,
      undefined,
    ]);
  });

  it("round-trips filters, sort, rank range and search while keeping view and columns", () => {
    const base = new URLSearchParams("view=board&columns=done&status=blocked");
    const next = writeWorkListState(base, {
      filters: [
        { id: "type", value: ["bug"] },
        { id: "rankScore", value: [undefined, 4.5] },
      ],
      sorting: [{ id: "rankScore", desc: true }],
      query: "board",
    });
    expect(next.get("view")).toBe("board");
    expect(next.get("columns")).toBe("done");
    expect(next.get("type")).toBe("bug");
    expect(next.get("status")).toBe("all");
    expect(next.get("rankMin")).toBeNull();
    expect(next.get("rankMax")).toBe("4.5");
    expect(next.get("sort")).toBe("-rankScore");
    expect(next.get("q")).toBe("board");
  });
});
