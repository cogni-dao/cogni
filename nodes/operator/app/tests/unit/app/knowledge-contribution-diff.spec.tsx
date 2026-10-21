// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-contribution-diff`
 * Purpose: Verify retrieval triggers in the shared inbox permalink/drawer diff.
 * Scope: Real ContributionDiff fetch/render boundary; no live network.
 * Invariants: SUBTITLE_BELOW_TITLE, EXISTING_DIFF_ONLY, CITATIONS_UNCHANGED.
 * Side-effects: global (stubbed fetch)
 * Links: src/app/(app)/knowledge/_components/ContributionDiff.tsx
 * @vitest-environment jsdom
 * @internal
 */

import type { ContributionDiffEntry } from "@cogni/node-contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContributionDiff } from "@/app/(app)/knowledge/_components/ContributionDiff";

vi.mock("@/components", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

function mount(entries: ContributionDiffEntry[]) {
  const fetchMock = vi.fn(async () => Response.json({ entries }));
  vi.stubGlobal("fetch", fetchMock);
  render(<ContributionDiff contributionId="contrib-existing" />);
  return fetchMock;
}

function atom(useWhen?: string | null, entryType = "design") {
  return {
    id: "guidance",
    title: "Delivery guidance",
    content: entryType === "html" ? "<p>Visual body</p>" : "Guidance body",
    entryType,
    useWhen,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("inbox atom retrieval triggers", () => {
  it.each([
    "design",
    "html",
  ])("shows an added %s atom trigger below its title with only the existing diff read", async (entryType) => {
    const fetchMock = mount([
      {
        rowId: "guidance",
        changeType: "added",
        before: null,
        after: atom("  reviewing deployment guidance  ", entryType),
      },
    ]);
    const title = await screen.findByText("Delivery guidance");
    expect(title.nextElementSibling?.textContent).toBe(
      "Use when: reviewing deployment guidance"
    );
    if (entryType === "html") {
      await waitFor(() =>
        expect(
          screen.getByTitle("Delivery guidance").getAttribute("srcdoc")
        ).toContain("Visual body")
      );
      expect(
        screen.getByTitle("Delivery guidance").getAttribute("sandbox")
      ).toBe("allow-top-navigation-by-user-activation");
    } else {
      expect(screen.getByText("Guidance body")).toBeTruthy();
    }
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/knowledge/contributions/contrib-existing/diff",
      { credentials: "same-origin", cache: "no-store" }
    );
  });

  it("uses after for modified atoms and before for removed atoms", async () => {
    mount([
      {
        rowId: "modified",
        changeType: "modified",
        before: atom("obsolete trigger"),
        after: atom("updated trigger"),
      },
      {
        rowId: "removed",
        changeType: "removed",
        before: { ...atom("removed trigger"), title: "Removed guidance" },
        after: null,
      },
    ]);
    const titles = await screen.findAllByText("Delivery guidance");
    expect(titles[0]?.nextElementSibling?.textContent).toBe(
      "Use when: updated trigger"
    );
    expect(
      screen.getByText("Removed guidance").nextElementSibling?.textContent
    ).toBe("Use when: removed trigger");
    expect(screen.queryByText("obsolete trigger")).toBeNull();
  });

  it.each([
    undefined,
    null,
    "",
    "  ",
  ])("omits an absent or blank trigger (%j)", async (useWhen) => {
    mount([
      {
        rowId: "guidance",
        changeType: "added",
        before: null,
        after: atom(useWhen),
      },
    ]);
    await screen.findByText("Guidance body");
    expect(screen.queryByText("Use when:")).toBeNull();
  });

  it("keeps citation rows as links without atom subtitles", async () => {
    mount([
      {
        rowId: "edge",
        changeType: "citation_added",
        before: null,
        after: {
          citingId: "source",
          citedId: "target",
          citationType: "supports",
          useWhen: "not an atom",
        },
      },
    ]);
    expect(await screen.findByText("link +")).toBeTruthy();
    expect(screen.getByText("supports")).toBeTruthy();
    expect(screen.queryByText("Use when:")).toBeNull();
  });
});
