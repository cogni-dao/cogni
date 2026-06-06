// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/setup-node-action-panel`
 * Purpose: Unit coverage for the node wizard next-action panel handoff copy.
 * Scope: Client component behavior with router/fetch/clipboard mocked.
 * Side-effects: none
 * Links: src/app/(app)/setup/nodes/[id]/NodeActionPanel.client.tsx
 * @public
 */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components", () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly children?: ReactNode;
  }) => <button {...props}>{children}</button>,
}));

import { NodeActionPanel } from "@/app/(app)/setup/nodes/[id]/NodeActionPanel.client";

describe("NodeActionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ prompt: "launch prompt" }),
    }) as typeof fetch;
  });

  it("renders the published handoff as an AI-agent launch path", () => {
    render(
      <NodeActionPanel
        nodeId="11111111-1111-4111-8111-111111111111"
        status="published"
        publishedHandoff={{
          daoAddress: "0x1111111111111111111111111111111111111111",
          nodeSlug: "atlas",
          parentRepoUrl: "https://github.com/Cogni-DAO/cogni",
          publishPrUrl: "https://github.com/Cogni-DAO/cogni/pull/42",
        }}
      />
    );

    expect(screen.getByText("The node birth handoff is ready.")).toBeVisible();
    expect(screen.getByText(/node customization PR/)).toBeVisible();
    expect(screen.getByText(/normal node CI/)).toBeVisible();
    expect(screen.getByText(/operator flight request/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Parent PR/ })).toHaveAttribute(
      "href",
      "https://github.com/Cogni-DAO/cogni/pull/42"
    );
    expect(
      screen.getByRole("button", { name: "Copy launch prompt" })
    ).toHaveTextContent("Copy agent prompt");
    expect(screen.getByText(/not part of this launch handoff/)).toBeVisible();
  });

  it("copies the launch prompt from the owner-gated API", async () => {
    render(<NodeActionPanel nodeId="node-1" status="published" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy launch prompt" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/v1/nodes/node-1/launch-pack"
      );
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "launch prompt"
      );
    });
  });
});
