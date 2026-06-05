// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/nodes/components`
 * Purpose: Unit coverage for the public nodes gallery, card, detail, and registration UI.
 * Scope: Renders feature components with mocked browser/Next dependencies. No network IO.
 * Side-effects: mocked fetch/router only
 * Links: src/features/nodes/components
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ImgHTMLAttributes, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeDetailView } from "@/features/nodes/components/NodeDetailView";
import { NodeNetworkCard } from "@/features/nodes/components/NodeNetworkCard";
import { NodeRegistrationForm } from "@/features/nodes/components/NodeRegistrationForm.client";
import { NodesGallery } from "@/features/nodes/components/NodesGallery";
import type { NodeSummary } from "@/ports";

const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    fill: _fill,
    priority: _priority,
    ...props
  }: ImgHTMLAttributes<HTMLImageElement> & {
    readonly src: string | { readonly src: string };
    readonly fill?: boolean;
    readonly priority?: boolean;
  }): ReactElement => (
    // biome-ignore lint/performance/noImgElement: next/image is mocked as a plain element for jsdom assertions.
    <img
      {...props}
      alt={alt ?? ""}
      src={typeof src === "string" ? src : src.src}
    />
  ),
}));

const alpha: NodeSummary = {
  slug: "alpha",
  nodeId: "11111111-1111-4111-8111-111111111111",
  title: "Alpha Node",
  tagline: "First public node",
  kind: "full-app",
  repo: {
    owner: "Cogni-DAO",
    name: "alpha",
    url: "https://github.com/Cogni-DAO/alpha",
  },
  href: "https://alpha-test.cognidao.org",
  thumbnailUrl: "/showcase/alpha.png",
};

const beta: NodeSummary = {
  slug: "beta",
  title: "Beta Node",
  tagline: "",
  kind: "agent-scope",
  href: "#",
};

const alphaMetrics = {
  devActivity30d: 12,
  devActivityTotal: 30,
  aiUsage: { state: "available" as const, requests30d: 44 },
  latestEpoch: {
    id: "7",
    status: "finalized" as const,
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-01-31T00:00:00.000Z",
  },
  finalizedEpochCount: 3,
};

const betaMetrics = {
  devActivity30d: 0,
  devActivityTotal: 0,
  aiUsage: {
    state: "unavailable" as const,
    reason: "AI usage needs node-correlated charge receipts",
  },
  latestEpoch: null,
  finalizedEpochCount: 0,
};

describe("nodes feature components", () => {
  beforeEach(() => {
    router.push.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("renders a node card with thumbnail, metrics, repo detail link, and visit action", () => {
    render(<NodeNetworkCard node={alpha} metrics={alphaMetrics} />);

    expect(
      screen.getByRole("img", { name: "Alpha Node homepage" })
    ).toHaveAttribute("src", "/showcase/alpha.png");
    expect(screen.getByRole("heading", { name: "Alpha Node" })).toBeVisible();
    expect(screen.getByText("finalized #7")).toBeVisible();
    expect(screen.getByRole("link", { name: "Details" })).toHaveAttribute(
      "href",
      "/nodes/alpha"
    );
    expect(screen.getByRole("link", { name: /Visit/ })).toHaveAttribute(
      "href",
      "https://alpha-test.cognidao.org"
    );
  });

  it("renders unavailable card state without external visit action", () => {
    render(<NodeNetworkCard node={beta} metrics={betaMetrics} />);

    expect(screen.getByText("B")).toBeVisible();
    expect(screen.getByText("Scope")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.queryByRole("link", { name: /Visit/ })).toBeNull();
  });

  it("renders gallery totals, leaderboards, cards, and registration slot", () => {
    render(
      <NodesGallery
        items={[
          { node: alpha, metrics: alphaMetrics },
          { node: beta, metrics: betaMetrics },
        ]}
        registrationForm={<div>Registration Form Slot</div>}
      />
    );

    expect(screen.getByRole("heading", { name: "Cogni Nodes" })).toBeVisible();
    expect(screen.getByText("Listed nodes")).toBeVisible();
    expect(screen.getByText("30d dev activity")).toBeVisible();
    expect(screen.getByText("AI usage feeds")).toBeVisible();
    expect(screen.getByText("1/2")).toBeVisible();
    expect(screen.getByText("Dev Activity")).toBeVisible();
    expect(screen.getByText("Epochs Completed")).toBeVisible();
    fireEvent.click(screen.getByText("Launch or Register Node"));
    expect(screen.getByText("Registration Form Slot")).toBeVisible();
  });

  it("renders node detail metrics, repo link, epoch, and ownership table", () => {
    render(
      <NodeDetailView
        node={alpha}
        metrics={alphaMetrics}
        topOwners={[
          {
            claimantKey: "user:1",
            displayName: "Ada",
            claimantLabel: "Linked account",
            isLinked: true,
            totalCredits: 1000,
            ownershipPercent: 75,
            epochsContributed: 2,
          },
          {
            claimantKey: "wallet:0xabc",
            displayName: null,
            claimantLabel: "Unlinked account",
            isLinked: false,
            totalCredits: 333,
            ownershipPercent: 25,
            epochsContributed: 1,
          },
        ]}
      />
    );

    expect(screen.getByRole("heading", { name: "Alpha Node" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Repo/ })).toHaveAttribute(
      "href",
      "https://github.com/Cogni-DAO/alpha"
    );
    expect(screen.getByText("Epoch #7")).toBeVisible();
    expect(screen.getByText("Ada")).toBeVisible();
    expect(screen.getAllByText("Contributor")).toHaveLength(2);
    expect(screen.getByText("75%")).toBeVisible();
  });

  it("renders node detail empty states for unavailable metrics", () => {
    render(<NodeDetailView node={beta} metrics={betaMetrics} topOwners={[]} />);

    expect(
      screen.getByText("No epoch data is available for this node yet.")
    ).toBeVisible();
    expect(
      screen.getByText("AI usage needs node-correlated charge receipts")
    ).toBeVisible();
    expect(
      screen.getByText(
        "No finalized ownership rows are available for this node yet."
      )
    ).toBeVisible();
  });

  it("submits registration and routes to the canonical setup page", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        node: { id: "33333333-3333-4333-8333-333333333333" },
      }),
    } as Response);

    render(<NodeRegistrationForm />);

    const input = screen.getByLabelText("Node slug");
    fireEvent.change(input, { target: { value: "Gamma" } });
    fireEvent.click(screen.getByRole("button", { name: "Register node" }));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(
        "/setup/nodes/33333333-3333-4333-8333-333333333333"
      );
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/nodes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ slug: "gamma", chainId: 8453 }),
      })
    );
  });

  it("shows registration errors and keeps invalid slugs disabled", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ reason: "slug taken" }),
    } as Response);

    render(<NodeRegistrationForm />);

    const button = screen.getByRole("button", { name: "Register node" });
    fireEvent.change(screen.getByLabelText("Node slug"), {
      target: { value: "-bad" },
    });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(
        "2-32 chars, lowercase letters/numbers/dashes, starts with a letter"
      )
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Node slug"), {
      target: { value: "taken" },
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("slug taken")).toBeVisible();
    });
  });
});
