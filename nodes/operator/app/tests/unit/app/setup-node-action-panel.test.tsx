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
import {
  type ButtonHTMLAttributes,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components", () => ({
  Button: ({
    children,
    asChild,
    rightIcon: _rightIcon,
    iconSize: _iconSize,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly asChild?: boolean;
    readonly rightIcon?: ReactNode;
    readonly iconSize?: string;
    readonly children?: ReactNode;
  }) => {
    if (asChild && isValidElement(children)) {
      const child = children as ReactElement<Record<string, unknown>>;
      return cloneElement(child, {
        ...props,
        ...child.props,
      });
    }
    return <button {...props}>{children}</button>;
  },
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
          nodeRepoUrl: "https://github.com/cogni-test-org/atlas",
          knowledgeRepoUrl: "https://www.dolthub.com/cogni-dao/knowledge-atlas",
          publishPrUrl: "https://github.com/Cogni-DAO/cogni/pull/42",
        }}
      />
    );

    expect(screen.getByText("Launch pack ready.")).toBeVisible();
    expect(
      screen.getByText(/open the new node repo and DoltHub repo/)
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Node repo/ })).toHaveAttribute(
      "href",
      "https://github.com/cogni-test-org/atlas"
    );
    expect(screen.getByRole("link", { name: /DoltHub repo/ })).toHaveAttribute(
      "href",
      "https://www.dolthub.com/cogni-dao/knowledge-atlas"
    );
    expect(screen.getByRole("link", { name: /Deployment PR/ })).toHaveAttribute(
      "href",
      "https://github.com/Cogni-DAO/cogni/pull/42"
    );
    const copyButton = screen.getByRole("button", {
      name: "Copy launch prompt",
    });
    expect(copyButton).toHaveTextContent("Copy agent prompt");
    expect(
      copyButton.compareDocumentPosition(
        screen.getByRole("link", { name: /Node repo/ })
      )
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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
