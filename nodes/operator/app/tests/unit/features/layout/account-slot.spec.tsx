// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/layout/account-slot`
 * Purpose: Unit coverage for the shared session-aware account header slot.
 * Scope: Mocks NextAuth, wallet, and avatar components. No wallet/session IO.
 * Side-effects: none
 * Links: src/features/layout/components/AccountSlot.tsx
 * @vitest-environment jsdom
 */

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({
  status: "unauthenticated" as "authenticated" | "loading" | "unauthenticated",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: sessionMock.status }),
}));

vi.mock("@/components", () => ({
  Button: ({
    asChild: _asChild,
    children,
  }: {
    readonly asChild?: boolean;
    readonly children?: ReactNode;
  }) => <>{children}</>,
}));

vi.mock("@/components/kit/auth/WalletConnectButton", () => ({
  WalletConnectButton: ({ variant }: { readonly variant?: string }) => (
    <div data-testid={`wallet-${variant ?? "default"}`}>Connect</div>
  ),
}));

vi.mock("@/features/layout/components/UserAvatarMenu", () => ({
  UserAvatarMenu: () => <div data-testid="user-avatar-menu" />,
}));

import { AccountSlot } from "@/features/layout/components/AccountSlot";

describe("AccountSlot", () => {
  beforeEach(() => {
    sessionMock.status = "unauthenticated";
  });

  it("renders wallet sign-in affordances when unauthenticated", () => {
    render(<AccountSlot />);

    expect(screen.getByTestId("wallet-compact")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-default")).toBeInTheDocument();
    expect(screen.queryByTestId("user-avatar-menu")).toBeNull();
  });

  it("renders the avatar menu instead of connect controls when authenticated", () => {
    sessionMock.status = "authenticated";

    render(<AccountSlot showAppLink />);

    expect(screen.getByTestId("user-avatar-menu")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open app" })).toHaveAttribute(
      "href",
      "/chat"
    );
    expect(screen.queryByText("Connect")).toBeNull();
  });

  it("does not flash connect controls while session state is loading", () => {
    sessionMock.status = "loading";

    render(<AccountSlot />);

    expect(screen.queryByText("Connect")).toBeNull();
    expect(screen.queryByTestId("user-avatar-menu")).toBeNull();
  });
});
