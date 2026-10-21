// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-direct-links`
 * Purpose: Prove ordinary atom reads never walk chains and load more links only on demand.
 * Scope: React Query plus browser fetch boundary. Does not use a live network.
 * Invariants: NO_AUTOMATIC_CHAIN, FIVE_INITIAL_LINKS, EXPLICIT_PAGINATION.
 * Side-effects: global (stubbed fetch)
 * Links: https://github.com/cogni-dao/cogni/issues/2832
 * @vitest-environment jsdom
 * @internal
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEntryView } from "@/app/(app)/knowledge/_components/KnowledgeEntryView";

vi.mock("@/components", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, disabled, onClick }: ComponentProps<"button">) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/app/(app)/knowledge/_components/ConfidenceBar", () => ({
  ConfidenceBar: () => null,
}));

function link(i: number) {
  return {
    id: `edge-${i}`,
    direction: "out",
    citationType: "supports",
    source: {
      id: "root",
      title: "Root",
      kind: "knowledge",
      href: "/knowledge/root",
    },
    target: {
      id: `atom-${i}`,
      title: `Related ${i}`,
      kind: "knowledge",
      href: `/knowledge/atom-${i}`,
    },
    context: null,
  };
}

function mount(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeEntryView id="root" />
    </QueryClientProvider>
  );
}

function body() {
  return {
    id: "root",
    domain: "meta",
    entityId: null,
    title: "Root atom",
    content: "Only the selected atom body",
    entryType: "finding",
    confidencePct: 80,
    sourceType: "human",
    sourceRef: null,
    tags: null,
    createdAt: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ordinary knowledge reads", () => {
  it("fetches one body and five direct links, then fetches more only after a click", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/v1/knowledge/root") return Response.json(body());
      if (input === "/api/v1/citations/root") {
        return Response.json({
          links: [0, 1, 2, 3, 4].map(link),
          nextCursor: "edge-4",
        });
      }
      if (input === "/api/v1/citations/root?cursor=edge-4") {
        return Response.json({ links: [5, 6].map(link), nextCursor: null });
      }
      throw new Error(`Unexpected read: ${input}`);
    });
    mount(fetchMock);
    await screen.findByText("Only the selected atom body");
    await screen.findByRole("link", { name: "supports Related 4" });
    expect(screen.queryByText("supports Related 5")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/knowledge/root",
      "/api/v1/citations/root",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "More links" }));
    await screen.findByRole("link", { name: "supports Related 6" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "More links" })).toBeNull()
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(([url]) => url.includes("/edo/chain/"))
    ).toBe(false);
  });

  it("keeps loaded relationships visible and reports a failed next page", async () => {
    mount(
      vi.fn(async (input: string) => {
        if (input === "/api/v1/knowledge/root") return Response.json(body());
        if (input === "/api/v1/citations/root") {
          return Response.json({ links: [link(0)], nextCursor: "edge-0" });
        }
        return Response.json({ error: "unavailable" }, { status: 503 });
      })
    );
    await screen.findByRole("link", { name: "supports Related 0" });
    fireEvent.click(screen.getByRole("button", { name: "More links" }));
    await screen.findByRole("alert");
    expect(
      screen.getByRole("link", { name: "supports Related 0" })
    ).toBeTruthy();
    expect(screen.getByText("Only the selected atom body")).toBeTruthy();
  });
});
