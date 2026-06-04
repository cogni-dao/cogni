// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/app-layout-auth-guard`
 * Purpose: Unit tests for (app)/layout — verifies it renders as a pure UI shell.
 * Scope: Tests that AppLayout renders children unconditionally (auth is enforced at proxy level, not layout).
 * Invariants: Layout is a pure shell — no auth logic, no redirects. Proxy.ts is the single authority.
 * Side-effects: none (mocked components)
 * Notes: Uses React Testing Library with mocked layout components. DOM environment via test-level override.
 * Links: src/app/(app)/layout.tsx, src/proxy.ts, docs/spec/security-auth.md
 * @public
 */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub sidebar shell so this test stays scoped to the layout behavior
vi.mock("@/components", () => ({
  SidebarProvider: ({ children }: { children?: ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarInset: ({ children }: { children?: ReactNode }) => (
    <div data-testid="sidebar-inset">{children}</div>
  ),
}));

vi.mock("@/features/layout", () => ({
  AppSidebar: () => <div data-testid="app-sidebar" />,
  AppTopBar: () => <div data-testid="app-topbar" />,
}));

describe("AppLayout Shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children within sidebar layout shell", async () => {
    const { default: APP_LAYOUT } = await import("@/app/(app)/layout");

    render(
      <APP_LAYOUT>
        <div data-testid="children">Protected Content</div>
      </APP_LAYOUT>
    );

    // Should render the full layout structure
    expect(screen.getByTestId("sidebar-provider")).toBeInTheDocument();
    expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-inset")).toBeInTheDocument();
    expect(screen.getByTestId("app-topbar")).toBeInTheDocument();

    // Should render children
    expect(screen.getByTestId("children")).toBeInTheDocument();
    expect(screen.getByText("Protected Content")).toBeInTheDocument();
  });
});
