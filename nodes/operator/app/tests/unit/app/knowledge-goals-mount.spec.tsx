// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-goals-mount`
 * Purpose: Prove this node's mount of the published Goals board (story.0021): `KnowledgeGoalsBoard` renders the package board under its own host and reads `GET /api/v1/metrics/goals` with the session cookie. The board, chart and read client themselves are proven in the node-template `@cogni/knowledge-base-ui` package.
 * Scope: React Query plus the browser fetch boundary, rendering the real `@cogni/knowledge-base-ui/goals` entry. No live network.
 * Invariants: ENDPOINT_IS_THE_NODE_ROUTE (the package default client reads `/api/v1/metrics`); SEED_RENDERS_WITHOUT_FETCH_BLOCKING (SSR `initialData` paints the goal title).
 * Side-effects: global (stubbed fetch)
 * Links: app/src/app/(app)/knowledge/_components/GoalsMount.tsx
 * @vitest-environment jsdom
 * @internal
 */

import { GoalsProgressSchema } from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeGoalsBoard } from "@/app/(app)/knowledge/_components/GoalsMount";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function progress(title: string) {
  return GoalsProgressSchema.parse({
    asOf: "2026-11-02T10:05:00.000Z",
    environment: "local",
    goals: [
      {
        id: "goal-x",
        title,
        evaluateAt: "2027-01-31T00:00:00.000Z",
        configurationError: false,
        kpis: [],
        hypotheses: [],
        moreHypotheses: false,
        hypothesesUnavailable: false,
      },
    ],
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBoard(initialData?: ReturnType<typeof progress>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <KnowledgeGoalsBoard {...(initialData ? { initialData } : {})} />
    </QueryClientProvider>
  );
}

describe("KnowledgeGoalsBoard", () => {
  it("paints the SSR seed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(progress("Goal: Ship it")), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );
    renderBoard(progress("Goal: Ship it"));
    expect(await screen.findByText(/Goal: Ship it/)).toBeTruthy();
  });

  it("reads the node's goals route when there is no seed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(progress("Goal: Read me")), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    renderBoard();
    expect(await screen.findByText(/Goal: Read me/)).toBeTruthy();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/metrics/goals");
  });
});
