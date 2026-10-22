// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-direct-links`
 * Purpose: Prove atom selections never walk chains and load more links only on demand.
 * Scope: React Query plus browser fetch boundary. Does not use a live network.
 * Invariants: NO_AUTOMATIC_CHAIN, FIVE_INITIAL_LINKS, EXPLICIT_PAGINATION.
 * Side-effects: global (stubbed fetch)
 * Links: https://github.com/cogni-dao/cogni/issues/2832
 * @vitest-environment jsdom
 * @internal
 */

import type { KnowledgeRow } from "@cogni/node-contracts";
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
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";

const navigation = vi.hoisted(() => ({ mode: "browse" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ mode: navigation.mode }),
}));

// Replace only grid/WebGL/chrome: selection handlers, details, fields, and
// the shared direct-relation component execute their real production code.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    ({
      graphData,
      onNodeClick,
    }: {
      graphData: {
        nodes: Array<{ id: string; title: string; isHub: boolean }>;
      };
      onNodeClick: (node: { id: string; isHub: boolean }) => void;
    }) => (
      <div>
        {graphData.nodes
          .filter((node) => !node.isHub)
          .map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => onNodeClick(node)}
            >
              Select graph atom {node.title}
            </button>
          ))}
      </div>
    ),
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid", () => ({
  DataGrid: ({
    table,
    onRowClick,
  }: {
    table: {
      getRowModel: () => {
        rows: Array<{ id: string; original: KnowledgeRow }>;
      };
    };
    onRowClick: (row: KnowledgeRow) => void;
  }) => (
    <div>
      {table.getRowModel().rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onRowClick(row.original)}
        >
          Select table atom {row.original.title}
        </button>
      ))}
    </div>
  ),
  DataGridContainer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock(
  "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility",
  () => ({ DataGridColumnVisibility: () => null })
);
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-pagination", () => ({
  DataGridPagination: () => null,
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-table", () => ({
  DataGridTable: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/AddDomainSheet", () => ({
  AddDomainSheet: () => null,
}));

vi.mock("@/components", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, disabled, onClick }: ComponentProps<"button">) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
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

function mount(
  fetchMock: ReturnType<typeof vi.fn>,
  element: ReactNode = <KnowledgeEntryView id="root" />
) {
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function body(useWhen: string | null = null) {
  return {
    id: "root",
    domain: "meta",
    entityId: null,
    title: "Root atom",
    content: "Only the selected atom body",
    useWhen,
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

  it("shows the retrieval trigger directly below the title without another request", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/v1/knowledge/root") {
        return Response.json(
          body("  Choose this atom when reviewing a node repair.  ")
        );
      }
      if (input === "/api/v1/citations/root") {
        return Response.json({ links: [], nextCursor: null });
      }
      throw new Error(`Unexpected read: ${input}`);
    });
    mount(fetchMock);
    const title = await screen.findByRole("heading", { name: "Root atom" });
    expect(title.nextElementSibling?.textContent).toBe(
      "Use when: Choose this atom when reviewing a node repair."
    );
    await screen.findByText("Only the selected atom body");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it.each([
    null,
    "",
    "   ",
  ])("omits the retrieval-trigger field for %j", async (useWhen) => {
    mount(
      vi.fn(async (input: string) => {
        if (input === "/api/v1/knowledge/root")
          return Response.json(body(useWhen));
        if (input === "/api/v1/citations/root") {
          return Response.json({ links: [], nextCursor: null });
        }
        throw new Error(`Unexpected read: ${input}`);
      })
    );
    await screen.findByText("Only the selected atom body");
    expect(screen.queryByText("Use when:")).toBeNull();
  });
});

describe("knowledge selection surfaces", () => {
  it.each([
    "browse",
    "chains",
    "graph",
  ])("%s selection renders the selected body and pages direct links without chain reads", async (mode) => {
    navigation.mode = mode;
    const selected = {
      ...body("  Choose this atom when reviewing a node repair.  "),
      entryType: "decision",
    };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/v1/knowledge/contributions?state=open&limit=100") {
        return Response.json({ contributions: [] });
      }
      if (input === "/api/v1/citations/root") {
        return Response.json({
          links: [0, 1, 2, 3, 4].map(link),
          nextCursor: "edge-4",
        });
      }
      if (input === "/api/v1/citations/root?cursor=edge-4") {
        return Response.json({ links: [link(5)], nextCursor: null });
      }
      throw new Error(`Unexpected selection read: ${input}`);
    });
    mount(
      fetchMock,
      <KnowledgeDashboardView
        initialList={{ items: [selected], domains: ["meta"] }}
        initialDomains={{ domains: [] }}
        initialGraph={{ nodes: [selected], edges: [], domains: ["meta"] }}
      />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Only the selected atom body")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Select ${mode === "graph" ? "graph" : "table"} atom Root atom`,
      })
    );
    await screen.findByText("Only the selected atom body");
    await screen.findByRole("link", { name: "supports Related 4" });
    const title = screen.getByRole("heading", { name: "Root atom" });
    expect(title.nextElementSibling?.textContent).toBe(
      "Use when: Choose this atom when reviewing a node repair."
    );
    expect(screen.queryByText("supports Related 5")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/knowledge/contributions?state=open&limit=100",
      "/api/v1/citations/root",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "More links" }));
    await screen.findByRole("link", { name: "supports Related 5" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/knowledge/contributions?state=open&limit=100",
      "/api/v1/citations/root",
      "/api/v1/citations/root?cursor=edge-4",
    ]);
  });
});
