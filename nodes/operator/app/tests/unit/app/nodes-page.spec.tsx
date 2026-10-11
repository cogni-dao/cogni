// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Rendering coverage for the authenticated node list's empty and populated states. */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSessionUser: vi.fn(),
  listOwnedNodes: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: mocks.getServerSessionUser,
}));

vi.mock("@/app/_facades/nodes/owned.server", () => ({
  listOwnedNodes: mocks.listOwnedNodes,
}));

vi.mock("@/app/(app)/nodes/NewNodeForm.client", () => ({
  NewNodeForm: () => <div>New node form</div>,
}));

vi.mock("@/components", () => ({
  PageContainer: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  SectionCard: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: string;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock("@/features/nodes/components/NodeTile", () => ({
  NodeTile: ({
    node,
  }: {
    node: { title: string; href: string; status?: { label: string } };
  }) => (
    <a href={node.href}>
      {node.title} {node.status?.label}
    </a>
  ),
}));

import SetupNodesPage from "@/app/(app)/nodes/page";

describe("nodes page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSessionUser.mockResolvedValue({ id: "user-1" });
  });

  it("renders the empty owner state", async () => {
    mocks.listOwnedNodes.mockResolvedValue([]);

    render(await SetupNodesPage());

    expect(screen.getByRole("heading", { name: "Your nodes" })).toBeVisible();
    expect(screen.getByText(/No nodes yet/)).toBeVisible();
    expect(mocks.listOwnedNodes).toHaveBeenCalledWith("user-1");
  });

  it("renders local identity and status for owned nodes", async () => {
    mocks.listOwnedNodes.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "alpha-node",
        status: "active",
      },
    ]);

    render(await SetupNodesPage());

    expect(
      screen.getByRole("link", { name: "Alpha Node Payments ready" })
    ).toHaveAttribute("href", "/nodes/11111111-1111-4111-8111-111111111111");
  });
});
