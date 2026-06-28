// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/node-handoff-step`
 * Purpose: Unit coverage for the wizard handoff step — the AI-agent launch-pack payoff.
 * Scope: Client component behavior with fetch/clipboard mocked; asserts preserved handoff copy,
 *   the four created-artifact links (incl. Aragon DAO), and copy-button ordering.
 * Side-effects: none
 * Links: src/features/nodes/wizard/steps/HandoffStep.client.tsx
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
      return cloneElement(child, { ...props, ...child.props });
    }
    return <button {...props}>{children}</button>;
  },
  SectionCard: ({ children }: { readonly children?: ReactNode }) => (
    <section>{children}</section>
  ),
}));

vi.mock("@/features/nodes/wizard/steps/PaymentActivationStep.client", () => ({
  PaymentActivationStep: ({ node }: { readonly node: WizardNode }) => (
    <section>Payments panel for {node.slug}</section>
  ),
}));

import { HandoffStep } from "@/features/nodes/wizard/steps/HandoffStep.client";
import type { WizardNode } from "@/features/nodes/wizard/types";

function makeNode(overrides: Partial<WizardNode> = {}): WizardNode {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "atlas",
    status: "published",
    daoAddress: "0x1111111111111111111111111111111111111111",
    chainId: 8453,
    operatorWalletAddress: null,
    splitAddress: null,
    publishPrUrl: "https://github.com/Cogni-DAO/cogni/pull/42",
    failureReason: null,
    nodeRepoUrl: "https://github.com/cogni-test-org/atlas",
    knowledgeRepoUrl:
      "https://www.dolthub.com/repositories/cogni-dao/knowledge-atlas",
    daoUrl:
      "https://app.aragon.org/dao/base-mainnet/0x1111111111111111111111111111111111111111",
    repoSpecUrl:
      "https://github.com/cogni-test-org/atlas/blob/main/.cogni/repo-spec.yaml",
    paymentActivation: null,
    ...overrides,
  };
}

describe("HandoffStep", () => {
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

  it("renders the launch pack with all four artifact links incl. Aragon DAO", () => {
    render(<HandoffStep node={makeNode()} />);

    expect(screen.getByText("Ready for your AI developer")).toBeVisible();
    expect(screen.getByText(/This is where development begins/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Node repo/ })).toHaveAttribute(
      "href",
      "https://github.com/cogni-test-org/atlas"
    );
    expect(screen.getByRole("link", { name: /DoltHub repo/ })).toHaveAttribute(
      "href",
      "https://www.dolthub.com/repositories/cogni-dao/knowledge-atlas"
    );
    expect(screen.getByRole("link", { name: /Deployment PR/ })).toHaveAttribute(
      "href",
      "https://github.com/Cogni-DAO/cogni/pull/42"
    );
    expect(screen.getByRole("link", { name: /Aragon DAO/ })).toHaveAttribute(
      "href",
      "https://app.aragon.org/dao/base-mainnet/0x1111111111111111111111111111111111111111"
    );

    const copyButton = screen.getByRole("button", {
      name: "Copy launch prompt",
    });
    expect(copyButton).toHaveTextContent("Copy your AI-dev prompt");
    expect(
      copyButton.compareDocumentPosition(
        screen.getByRole("link", { name: /Node repo/ })
      )
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      screen.getByRole("button", { name: /Continue to payments/ })
    ).toBeVisible();
  });

  it("keeps the launch prompt available when artifact links are missing", () => {
    render(
      <HandoffStep
        node={makeNode({
          nodeRepoUrl: null,
          knowledgeRepoUrl: null,
          publishPrUrl: null,
          daoUrl: null,
        })}
      />
    );

    expect(screen.getByText("Ready for your AI developer")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy launch prompt" })
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: /Node repo/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Aragon DAO/ })).toBeNull();
  });

  it("copies the launch prompt from the owner-gated API", async () => {
    render(<HandoffStep node={makeNode({ id: "node-1" })} />);

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

  it("opens the payments panel from the handoff CTA", () => {
    render(<HandoffStep node={makeNode()} />);

    fireEvent.click(
      screen.getByRole("button", { name: /Continue to payments/ })
    );

    expect(screen.getByText("Payments panel for atlas")).toBeVisible();
  });

  it("resumes the payments panel when activation already started", () => {
    render(
      <HandoffStep
        node={makeNode({
          paymentActivation: {
            repoSpecActive: false,
            sourceSha: "abc123",
            activationPrUrl: "https://github.com/cogni-test-org/atlas/pull/1",
            activationPrState: "open",
            productionBuildSha: null,
            productionMatchesSource: false,
          },
        })}
      />
    );

    expect(screen.getByText("Payments panel for atlas")).toBeVisible();
  });
});
