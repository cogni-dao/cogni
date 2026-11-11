// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/entity-peek`
 * Purpose: Prove citation links open knowledge entries in the side sheet and keep new-tab clicks.
 * Scope: EntityPeekProvider + PeekLink over a stubbed entry read. No live network.
 * Invariants: PEEK_KEEPS_PAGE, MODIFIED_CLICK_NAVIGATES, WORK_ITEMS_NAVIGATE.
 * Side-effects: global (stubbed fetch)
 * Links: bug.0011
 * @vitest-environment jsdom
 * @internal
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EntityPeekProvider,
  PeekLink,
} from "@/app/(app)/_components/EntityPeek";

vi.mock("@/components", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <EntityPeekProvider>
        <PeekLink
          href="/knowledge/dao-goals-design"
          entityId="dao-goals-design"
        >
          dao-goals-design
        </PeekLink>
        <PeekLink href="/work/items/task.0059" entityId="task.0059">
          task.0059
        </PeekLink>
      </EntityPeekProvider>
    </QueryClientProvider>
  );
}

describe("EntityPeek", () => {
  it("opens a knowledge link in the side sheet instead of navigating", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "not found" }, { status: 404 })
    );
    mount(fetchMock);

    const link = screen.getByRole("link", { name: "dao-goals-design" });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/knowledge/dao-goals-design"
    );
  });

  it("lets a modified click and a work-item link navigate", () => {
    const fetchMock = vi.fn();
    mount(fetchMock);

    const knowledge = screen.getByRole("link", { name: "dao-goals-design" });
    const newTab = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    knowledge.dispatchEvent(newTab);
    expect(newTab.defaultPrevented).toBe(false);

    const work = screen.getByRole("link", { name: "task.0059" });
    const workClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    work.dispatchEvent(workClick);
    expect(workClick.defaultPrevented).toBe(false);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
