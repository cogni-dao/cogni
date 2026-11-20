// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkItemDetail.test`
 * Purpose: Proves the binding names every route-backed detail state as an accessible sheet through the package view's header slots.
 * Scope: WorkItemDetail binding only; the sections and their reads are proven in the package (PACKAGE_ONLY_PROOF, story.0085).
 * Side-effects: DOM rendering in happy-dom
 * Links: bug.5355, ./WorkItemDetail.tsx
 */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import { WorkItemReadError } from "@cogni/knowledge-base-ui/work-item";
import type { WorkItemDto } from "@cogni/node-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkItemDetail } from "./WorkItemDetail";

// The view reads Links and Expectations through the package client; no node server runs here.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("{}", { status: 503 })
  );
});

const item: WorkItemDto = {
  id: "bug.5355",
  type: "bug",
  title: "Give every work item a human permalink",
  status: "needs_implement",
  assignees: [],
  externalRefs: [],
  labels: ["work-items"],
  specRefs: [],
  revision: 0,
  deployVerified: false,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};

// The Moves block and Expectations read through react-query (the node's real provider supplies it).
const clients = new Set<QueryClient>();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const client of clients) client.clear();
  clients.clear();
});

function renderDetail(
  overrides: Partial<React.ComponentProps<typeof WorkItemDetail>> = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.add(client);
  return render(
    <QueryClientProvider client={client}>
      <WorkItemDetail
        item={null}
        itemId="bug.5355"
        open
        onOpenChange={() => {}}
        {...overrides}
      />
    </QueryClientProvider>
  );
}

describe("WorkItemDetail accessibility states", () => {
  it("labels the loading state", () => {
    renderDetail({ isLoading: true });

    expect(
      screen.getByRole("dialog", { name: "Loading work item" })
    ).toBeInTheDocument();
  });

  it("labels only a typed 404 as not found", () => {
    renderDetail({ error: new WorkItemReadError("item", 404) });

    expect(
      screen.getByRole("dialog", { name: "Work item not found" })
    ).toBeInTheDocument();
  });

  it.each([401, 409, 503, 500])("labels HTTP %s as operational", (status) => {
    renderDetail({ error: new WorkItemReadError("item", status) });

    expect(
      screen.getByRole("dialog", { name: "Unable to load work item" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Work item not found" })
    ).not.toBeInTheDocument();
  });

  it("labels the loaded item with its title", () => {
    renderDetail({ item });

    expect(
      screen.getByRole("dialog", {
        name: "Give every work item a human permalink",
      })
    ).toBeInTheDocument();
  });
});
