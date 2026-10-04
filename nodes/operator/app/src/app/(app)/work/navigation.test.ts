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
  workItemHref,
  workListHref,
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
});
