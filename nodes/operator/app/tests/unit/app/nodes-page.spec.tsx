// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Rendering coverage for the authenticated node list's empty and populated states. */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

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

import { OwnedNodesContent } from "@/app/(app)/nodes/page";

describe("nodes page", () => {
  it("renders the empty owner state", () => {
    render(<OwnedNodesContent rows={[]} />);

    expect(screen.getByRole("heading", { name: "Your nodes" })).toBeVisible();
    expect(screen.getByText(/No nodes yet/)).toBeVisible();
  });

  it("renders local identity and status for owned nodes", () => {
    render(
      <OwnedNodesContent
        rows={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "alpha-node",
            status: "active",
          },
        ]}
      />
    );

    expect(
      screen.getByRole("link", { name: "Alpha Node Payments ready" })
    ).toHaveAttribute("href", "/nodes/11111111-1111-4111-8111-111111111111");
  });
});
