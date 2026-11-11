// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/contribution-diff-citations`
 * Purpose: Prove the inbox lists citation edges as one card per entry, names the citing side's
 *   relation, and never calls an edge-only inbox empty.
 * Scope: ContributionDiff over a stubbed diff response. Does not use a live network.
 * Invariants: CITATION_DIFF_FOR_REVIEW, EVERY_DIFF_EDGE_LISTED.
 * Side-effects: global (stubbed fetch)
 * Links: bug.0011
 * @vitest-environment jsdom
 * @internal
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContributionDiff } from "@/app/(app)/knowledge/_components/ContributionDiff";

vi.mock("@/components", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
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

function respond(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body))
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ContributionDiff citations", () => {
  it("lists every edge of an edge-only inbox and never says no changes", async () => {
    respond({
      contributionId: "contrib-1",
      branch: "contrib/1",
      entries: [
        {
          changeType: "citation_added",
          rowId: "edge-1",
          before: null,
          after: {
            citingId: "a-entry",
            citedId: "task.0059",
            citationType: "tracks",
          },
        },
        {
          changeType: "citation_removed",
          rowId: "edge-2",
          before: {
            citingId: "a-entry",
            citedId: "b-entry",
            citationType: "supports",
          },
          after: null,
        },
      ],
      citations: [
        {
          changeType: "added",
          citingId: "a-entry",
          citedId: "task.0059",
          citationType: "tracks",
          context: null,
          label: "tracks",
          tone: "neutral",
        },
        {
          changeType: "removed",
          citingId: "a-entry",
          citedId: "b-entry",
          citationType: "supports",
          context: null,
          label: "supports",
          tone: "positive",
        },
      ],
    });
    render(<ContributionDiff contributionId="contrib-1" />);

    // One card for the citing entry; both edges inside it, and no card per edge row.
    const section = await screen.findByRole("list", {
      name: "Link changes for a-entry",
    });
    // The card header plus each sentence row name the citing entry.
    expect(screen.getAllByText("a-entry")).toHaveLength(3);
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(section)
        .getByRole("link", { name: "link + a-entry tracks task.0059" })
        .getAttribute("href")
    ).toBe("/work/items/task.0059");
    expect(
      within(section)
        .getByRole("link", { name: "link − a-entry supports b-entry" })
        .getAttribute("href")
    ).toBe("/knowledge/b-entry");
    expect(screen.queryByText("edge-1")).toBeNull();
    expect(screen.queryByText(/No changes detected/)).toBeNull();
  });

  it("shows each entry once, with its authored change and the links it makes", async () => {
    const row = {
      id: "agent-development",
      title: "Add an agent graph",
      content: "Old body",
      useWhen: null,
      metricSpec: null,
      kpiBindings: null,
      entryType: "guide",
      domain: "build-agents",
    };
    respond({
      contributionId: "c",
      branch: "b",
      entries: [
        {
          changeType: "modified",
          rowId: "agent-development",
          before: row,
          after: { ...row, content: "New body" },
        },
      ],
      citations: [
        {
          changeType: "added",
          citingId: "agent-development",
          citedId: "frontend-development",
          citationType: "extends",
          context: null,
          label: "extends",
          tone: "neutral",
        },
      ],
    });
    render(<ContributionDiff contributionId="c" />);

    await screen.findByText("New body");
    expect(screen.getAllByText("agent-development")).toHaveLength(2);
    expect(screen.getAllByText("modified")).toHaveLength(1);
    expect(screen.getByText("Changed: content")).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: "link + agent-development extends frontend-development",
      })
    ).toBeTruthy();
  });

  it("shows a modified entry's confidence move in its header, not in Changed", async () => {
    const row = {
      id: "agent-development",
      title: "Add an agent graph",
      content: "Old body",
      useWhen: null,
      entryType: "guide",
      domain: "build-agents",
    };
    respond({
      contributionId: "c",
      branch: "b",
      entries: [
        {
          changeType: "modified",
          rowId: "agent-development",
          before: { ...row, confidencePct: 40 },
          after: { ...row, content: "New body", confidencePct: 55 },
        },
      ],
      citations: [],
    });
    render(<ContributionDiff contributionId="c" />);

    await screen.findByText("New body");
    expect(screen.getByText(/confidence 40% → 55%/)).toBeTruthy();
    expect(screen.getByText("Changed: content")).toBeTruthy();
  });

  it("says no changes only when neither rows nor edges changed", async () => {
    respond({ contributionId: "c", branch: "b", entries: [], citations: [] });
    render(<ContributionDiff contributionId="c" />);

    await screen.findByText("No changes detected.");
    expect(screen.queryByRole("list", { name: /Link changes/ })).toBeNull();
  });

  it("treats a server without citations as no edge changes", async () => {
    respond({ contributionId: "c", branch: "b", entries: [] });
    render(<ContributionDiff contributionId="c" />);

    await screen.findByText("No changes detected.");
  });
});
