// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/items/[id]/page.test`
 * Purpose: Proves the canonical work-item permalink preserves protected-route auth and logical route identity.
 * Scope: Server page wiring only.
 * Side-effects: none
 * Links: bug.5355, ./page.tsx
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import WorkItemPage from "./page";

const auth = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: auth }));
vi.mock("next/navigation", () => ({ redirect }));

vi.mock("../../view", () => ({
  WorkDashboardView: () => null,
}));

describe("WorkItemPage", () => {
  beforeEach(() => {
    auth.mockReset();
    redirect.mockReset();
  });

  it("projects the canonical permalink id into the route-backed view", async () => {
    auth.mockResolvedValue({ id: "user-1" });

    const element = await WorkItemPage({
      params: Promise.resolve({ id: "bug.5355" }),
    });

    expect(element.props.selectedItemId).toBe("bug.5355");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not decode an already-decoded route parameter a second time", async () => {
    auth.mockResolvedValue({ id: "user-1" });

    const element = await WorkItemPage({
      params: Promise.resolve({ id: "bug.%25" }),
    });

    expect(element.props.selectedItemId).toBe("bug.%25");
  });

  it("keeps direct permalinks behind the authenticated app boundary", async () => {
    auth.mockResolvedValue(null);

    await WorkItemPage({ params: Promise.resolve({ id: "bug.5355" }) });

    expect(redirect).toHaveBeenCalledWith("/");
  });
});
