// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * @vitest-environment jsdom
 *
 * Module: `@tests/unit/app/internship-home`
 * Purpose: Unit coverage for the public internship intake form.
 * Scope: Renders the client page, submits the short form, and verifies the Calendly handoff contract. Does not perform real network, calendar, or auth I/O.
 * Invariants: Form payload matches internship.interest.v1; success state exposes Derek interview booking URL.
 * Side-effects: none
 * Links: src/features/home/components/InternshipHome.tsx, src/contracts/internship.interest.v1.contract.ts
 * @public
 */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const walletMocks = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as
    | `0x${string}`
    | undefined,
  isConnected: true,
  isSigning: false,
  openConnectModal: vi.fn(),
  signMessageAsync: vi.fn(async () => `0x${"a".repeat(130)}` as `0x${string}`),
}));

type MotionProps = React.HTMLAttributes<HTMLElement> & {
  readonly children?: React.ReactNode;
  readonly animate?: unknown;
  readonly initial?: unknown;
  readonly transition?: unknown;
  readonly viewport?: unknown;
  readonly whileInView?: unknown;
};

vi.mock("framer-motion", () => {
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        React.forwardRef<HTMLElement, MotionProps>(
          (
            {
              children,
              animate: _animate,
              initial: _initial,
              transition: _transition,
              viewport: _viewport,
              whileInView: _whileInView,
              ...props
            },
            ref
          ) => React.createElement(tag, { ...props, ref }, children)
        ),
    }
  ) as Record<
    string,
    React.ForwardRefExoticComponent<
      MotionProps & React.RefAttributes<HTMLElement>
    >
  >;

  return {
    motion,
    useReducedMotion: () => true,
  };
});

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("@/components", () => ({
  Button: React.forwardRef<
    HTMLButtonElement,
    React.ButtonHTMLAttributes<HTMLButtonElement> & {
      readonly asChild?: boolean;
      readonly size?: string;
      readonly variant?: string;
    }
  >(({ asChild, children, size: _size, variant: _variant, ...props }, ref) =>
    asChild && React.isValidElement(children)
      ? children
      : React.createElement(
          "button",
          { type: props.type ?? "button", ...props, ref },
          children
        )
  ),
  Input: React.forwardRef<
    HTMLInputElement,
    React.InputHTMLAttributes<HTMLInputElement>
  >((props, ref) => React.createElement("input", { ...props, ref })),
}));

vi.mock("@/features/home/components/useInternshipWalletSignature", () => ({
  useInternshipWalletSignature: () => ({
    address: walletMocks.address,
    isConnected: walletMocks.isConnected,
    isSigning: walletMocks.isSigning,
    openConnectModal: walletMocks.openConnectModal,
    signMessage: walletMocks.signMessageAsync,
  }),
}));

vi.mock("@/features/home/components/InternshipNetworkBackground", () => ({
  InternshipNetworkBackground: () =>
    React.createElement("div", { "data-testid": "internship-background" }),
}));

describe("InternshipHome", () => {
  afterEach(() => {
    walletMocks.address = "0x1111111111111111111111111111111111111111";
    walletMocks.isConnected = true;
    walletMocks.isSigning = false;
    walletMocks.openConnectModal.mockClear();
    walletMocks.signMessageAsync.mockClear();
    walletMocks.signMessageAsync.mockImplementation(
      async () => `0x${"a".repeat(130)}` as `0x${string}`
    );
    vi.unstubAllGlobals();
  });

  async function renderForm(): Promise<{
    scoped: ReturnType<typeof within>;
    submitButton: HTMLElement;
    user: ReturnType<typeof userEvent.setup>;
  }> {
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];
      disconnect(): void {}
      observe(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve(): void {}
    }

    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const { InternshipHome } = await import(
      "@/features/home/components/InternshipHome"
    );
    render(React.createElement(InternshipHome));

    const submitButton = screen.getByRole("button", {
      name: walletMocks.isConnected
        ? /submit signed interest/i
        : /connect wallet to submit/i,
    });
    const form = submitButton.closest("form");
    expect(form).not.toBeNull();

    return {
      scoped: within(form as HTMLFormElement),
      submitButton,
      user: userEvent.setup(),
    };
  }

  async function fillShortForm(
    scoped: ReturnType<typeof within>,
    user: ReturnType<typeof userEvent.setup>
  ): Promise<void> {
    await user.type(
      scoped.getByLabelText("Interested?"),
      "Yes. I want to build applied AI products."
    );
    await user.type(
      scoped.getByLabelText("Portfolio link"),
      "https://github.com/ada/cogni-agent"
    );
    await user.selectOptions(
      scoped.getByLabelText("Niche direction"),
      "applied-ai-products"
    );
    await user.type(scoped.getByLabelText("Email"), "ada@example.com");
  }

  it("signs and submits streamlined intake fields with Derek interview handoff", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          ok: true,
          referenceId: "candidate-demo-001",
          derekInterviewUrl: "https://calendly.com/derekg1729",
        },
        { status: 201 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const { scoped, submitButton, user } = await renderForm();
    await fillShortForm(scoped, user);

    await user.click(submitButton);

    await waitFor(() =>
      expect(walletMocks.signMessageAsync).toHaveBeenCalledTimes(1)
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));

    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(payload).toMatchObject({
      email: "ada@example.com",
      portfolioUrl: "https://github.com/ada/cogni-agent",
      focus: "applied-ai-products",
      interest: "Yes. I want to build applied AI products.",
      walletAddress: "0x1111111111111111111111111111111111111111",
      walletSignature: `0x${"a".repeat(130)}`,
    });
    expect(payload.walletSignedAt).toEqual(expect.any(String));
    expect(payload.walletMessage).toContain("Cogni internship interest");
    expect(payload.walletMessage).toContain("Portfolio:");
    expect(payload.walletMessage).toContain("Interested in:");

    expect(await screen.findByText(/candidate-demo-001/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /book derek interview/i })
    ).toHaveAttribute("href", "https://calendly.com/derekg1729");
  });

  it("opens wallet connection instead of submitting when disconnected", async () => {
    walletMocks.address = undefined;
    walletMocks.isConnected = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { scoped, submitButton, user } = await renderForm();
    await fillShortForm(scoped, user);
    await user.click(submitButton);

    expect(walletMocks.openConnectModal).toHaveBeenCalledTimes(1);
    expect(walletMocks.signMessageAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a wallet signature error when signing fails", async () => {
    walletMocks.signMessageAsync.mockRejectedValueOnce(new Error("rejected"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { scoped, submitButton, user } = await renderForm();
    await fillShortForm(scoped, user);
    await user.click(submitButton);

    expect(
      await screen.findByText("Wallet signature was cancelled or failed.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a submission error when the endpoint rejects the signed interest", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "invalid input" }, { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { scoped, submitButton, user } = await renderForm();
    await fillShortForm(scoped, user);
    await user.click(submitButton);

    expect(
      await screen.findByText(
        "Submission failed. Check the fields and try again."
      )
    ).toBeInTheDocument();
  });
});
