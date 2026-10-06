// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkItemDetail.test`
 * Purpose: Proves every route-backed detail state exposes explicit accessible sheet semantics.
 * Scope: WorkItemDetail rendering only.
 * Side-effects: DOM rendering in happy-dom
 * Links: bug.5355, ./WorkItemDetail.tsx
 */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import type { WorkItemDto } from "@cogni/node-contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkItemFetchError } from "../_api/fetchWorkItems";
import { WorkItemDetail } from "./WorkItemDetail";

vi.mock("../../_components/EntityCitationLinks", () => ({
  EntityCitationLinks: () => null,
}));

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

function renderDetail(
  overrides: Partial<React.ComponentProps<typeof WorkItemDetail>> = {}
) {
  return render(
    <WorkItemDetail
      item={null}
      itemId="bug.5355"
      open
      onOpenChange={() => {}}
      {...overrides}
    />
  );
}

describe("WorkItemDetail accessibility states", () => {
  it("labels the loading state", () => {
    renderDetail({ isLoading: true });

    expect(
      screen.getByRole("heading", { name: "Loading work item" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("Loading details for bug.5355")
    ).toBeInTheDocument();
  });

  it("labels only a typed 404 as not found", () => {
    renderDetail({
      error: new WorkItemFetchError("not_found", "missing", 404),
    });

    expect(
      screen.getByRole("heading", { name: "Work item not found" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Work item bug.5355 does not exist or is not visible to you"
      )
    ).toBeInTheDocument();
  });

  it.each([
    "auth",
    "busy",
    "server",
    "network",
    "unexpected",
  ] as const)("labels %s failures as operational", (kind) => {
    renderDetail({ error: new WorkItemFetchError(kind, "failed") });

    expect(
      screen.getByRole("heading", { name: "Unable to load work item" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("The work-item request failed and can be retried")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Work item not found" })
    ).not.toBeInTheDocument();
  });

  it("labels the loaded item with its title and exact id", () => {
    renderDetail({ item });

    expect(
      screen.getByRole("heading", {
        name: "Give every work item a human permalink",
      })
    ).toBeInTheDocument();
    expect(screen.getByText("Details for bug.5355")).toBeInTheDocument();
  });
});
