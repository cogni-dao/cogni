// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/auth-prompt-handoff`
 * Purpose: Verify the completed sign-in shell commits before validated navigation.
 * Scope: Public sign-in handoff with mocked session, wallet, and navigation.
 * @vitest-environment happy-dom
 * @internal
 */

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthPrompt } from "@/app/(public)/AuthPrompt.client";

const state = vi.hoisted(() => ({
  status: "unauthenticated",
  params: new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({ useSession: () => state }));
vi.mock("next/navigation", () => ({ useSearchParams: () => state.params }));
vi.mock("wagmi", () => ({ useAccount: () => ({ isConnected: false }) }));
vi.mock("@rainbow-me/rainbowkit", () => ({
  useAccountModal: () => ({}),
  useConnectModal: () => ({}),
}));
vi.mock("@/components", async () => ({
  BrainLoading: (await import("@/components/kit/feedback/BrainLoading"))
    .BrainLoading,
}));
vi.mock("@/components/kit/auth/SignInDialog", () => ({
  SignInDialog: () => null,
}));
vi.mock("@/features/layout", () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="shared-app-shell">{children}</div>
  ),
}));

describe("Completed sign-in handoff", () => {
  beforeEach(() => {
    state.status = "unauthenticated";
    state.params = new URLSearchParams();
    vi.spyOn(window.location, "replace").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["loading", "unauthenticated"])(
    "waits while the session is %s",
    (status) => {
      state.status = status;
      render(<AuthPrompt />);
      expect(screen.queryByRole("status")).toBeNull();
      expect(window.location.replace).not.toHaveBeenCalled();
    }
  );

  it("commits the wordless shell before navigating to a validated callback", () => {
    state.status = "authenticated";
    state.params = new URLSearchParams({
      signIn: "1",
      callbackUrl: "/credits?tab=usage#balance",
    });
    vi.mocked(window.location.replace).mockImplementation(() => {
      expect(screen.getByTestId("shared-app-shell")).toBeInTheDocument();
      expect(screen.getByRole("status", { name: "Loading" }).textContent).toBe(
        ""
      );
    });

    render(<AuthPrompt />);

    expect(window.location.replace).toHaveBeenCalledExactlyOnceWith(
      "/credits?tab=usage#balance"
    );
  });

  it.each(["//evil.example/chat", "/unapproved", "https://evil.example"])(
    "falls back to chat for an invalid callback: %s",
    (callbackUrl) => {
      state.status = "authenticated";
      state.params = new URLSearchParams({ signIn: "1", callbackUrl });
      render(<AuthPrompt />);
      expect(window.location.replace).toHaveBeenCalledExactlyOnceWith("/chat");
    }
  );
});
