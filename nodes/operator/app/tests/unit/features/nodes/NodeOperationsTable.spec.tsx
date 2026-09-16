// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Accessible disclosure and display-safety coverage for the node operations table. */
// @vitest-environment jsdom

import type { NodeOperationsOverview } from "@cogni/node-contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { NodeOperationsTable } from "@/features/nodes/operations/NodeOperationsTable.client";

const node: NodeOperationsOverview = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "alpha",
  title: "Alpha",
  icon: "Brain",
  thumbnailUrl: null,
  brandColor: null,
  formationStatus: "active",
  relationship: "owner",
  detailUrl: "/nodes/11111111-1111-4111-8111-111111111111",
  modules: {
    deployment: {
      state: "available",
      status: "healthy",
      homepageUrl: "https://alpha.cognidao.org",
      environments: [
        {
          env: "production",
          label: "Production",
          declared: true,
          health: "healthy",
          sourceSha: "abcdef123456",
          buildSha: "abcdef123456",
          replicas: { desired: 1, ready: 1 },
        },
      ],
    },
    compute: {
      state: "available",
      sponsorship: "cogni",
      environment: "production",
      activeDeployments: 1,
      transferred: [{ amount: "341045", denom: "uact" }],
    },
    governance: {
      state: "available",
      daoUrl: "https://app.aragon.org/dao/base/0xabc",
      finalizedAttributionCredits: { state: "unavailable" },
      totalContributors: { state: "unavailable" },
      epochsCompleted: { state: "available", value: 4 },
      currentEpoch: {
        state: "available",
        value: { id: "7", status: "open" },
      },
    },
  },
};

describe("NodeOperationsTable", () => {
  it("uses real, uniquely targeted disclosure buttons with visible status text", async () => {
    const user = userEvent.setup();
    render(<NodeOperationsTable nodes={[node]} />);

    expect(screen.getAllByText("Healthy").length).toBeGreaterThan(0);
    const buttons = screen.getAllByRole("button", {
      name: "Show Alpha details",
    });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute("aria-expanded", "false");
    expect(buttons[0]?.getAttribute("aria-controls")).not.toBe(
      buttons[1]?.getAttribute("aria-controls")
    );

    buttons[0]?.focus();
    await user.keyboard("{Enter}");
    expect(buttons[0]).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(buttons[0]);

    await user.click(buttons[1] as HTMLElement);
    const ids = [...document.querySelectorAll("[id]")].map(
      (element) => element.id
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows only sponsored aggregates and no infrastructure identifiers", () => {
    const { container } = render(<NodeOperationsTable nodes={[node]} />);
    expect(screen.getAllByText("$0.34").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sponsored/).length).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent(/akash|wallet|lease|dseq|receipt/i);
    expect(container).not.toHaveTextContent(/owner/i);
  });

  it("renders one concise empty-state action", () => {
    render(<NodeOperationsTable nodes={[]} />);
    expect(screen.getByRole("heading", { name: "No nodes yet" })).toBeVisible();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Discover nodes" })
    ).toHaveAttribute("href", "/explore/nodes");
    expect(screen.queryByText(/Create node|New node/)).not.toBeInTheDocument();
  });

  it("renders the repo-spec Lucide mark and hosted image mark", () => {
    const imageNode = {
      ...node,
      id: "22222222-2222-4222-8222-222222222222",
      slug: "beta",
      title: "Beta",
      icon: "https://beta.example/logo.svg",
      detailUrl: "/nodes/22222222-2222-4222-8222-222222222222",
    };
    const { container } = render(
      <NodeOperationsTable nodes={[node, imageNode]} />
    );
    expect(screen.getAllByText("Alpha logo").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".lucide-brain").length).toBeGreaterThan(
      0
    );
    expect(screen.getAllByAltText("Beta logo").length).toBeGreaterThan(0);
  });

  it("filters the shared desktop and mobile row model by title or slug", async () => {
    const user = userEvent.setup();
    const beta = {
      ...node,
      id: "22222222-2222-4222-8222-222222222222",
      slug: "beta-community",
      title: "Beta",
      detailUrl: "/nodes/22222222-2222-4222-8222-222222222222",
    };
    render(<NodeOperationsTable nodes={[node, beta]} />);
    await user.type(
      screen.getByRole("textbox", { name: "Search nodes" }),
      "community"
    );
    expect(screen.queryAllByText("Alpha")).toHaveLength(0);
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
  });

  it("associates sponsored compute only with its observed environment", async () => {
    const user = userEvent.setup();
    const multiEnv = {
      ...node,
      modules: {
        ...node.modules,
        deployment: {
          ...node.modules.deployment,
          environments: [
            {
              ...node.modules.deployment.environments[0],
              env: "candidate-a" as const,
              label: "Test" as const,
              declared: false,
              health: "unknown" as const,
              buildSha: null,
            },
            {
              ...node.modules.deployment.environments[0],
              env: "preview" as const,
              label: "Preview" as const,
              declared: false,
              health: "unknown" as const,
              buildSha: null,
            },
            node.modules.deployment.environments[0],
          ],
        },
      },
    };
    render(<NodeOperationsTable nodes={[multiEnv]} />);
    await user.click(
      screen.getAllByRole("button", {
        name: "Show Alpha details",
      })[0] as HTMLElement
    );
    const expanded = document.getElementById(`${node.id}-operations-desktop`);
    expect(expanded).toHaveTextContent("Test");
    expect(expanded).toHaveTextContent("Preview");
    expect(expanded).toHaveTextContent("Production");
    expect(expanded?.textContent?.match(/Not deployed/g)).toHaveLength(2);
    expect(
      [...(expanded?.querySelectorAll("td") ?? [])].filter(
        (cell) => cell.textContent === "Unavailable"
      )
    ).toHaveLength(2);
    expect(expanded).toHaveTextContent("$0.34");
  });

  it("does not report zero when compute evidence is unavailable", () => {
    const unavailable = {
      ...node,
      modules: { ...node.modules, compute: { state: "unavailable" as const } },
    };
    render(<NodeOperationsTable nodes={[unavailable]} />);
    expect(screen.getByText(/Compute unavailable/)).toBeVisible();
    expect(screen.queryByText("$0 sponsored")).not.toBeInTheDocument();
  });

  it("labels a mixed-evidence sponsored total as partial", () => {
    const unavailable = {
      ...node,
      id: "22222222-2222-4222-8222-222222222222",
      slug: "beta",
      title: "Beta",
      detailUrl: "/nodes/22222222-2222-4222-8222-222222222222",
      modules: { ...node.modules, compute: { state: "unavailable" as const } },
    };
    render(<NodeOperationsTable nodes={[node, unavailable]} />);
    expect(
      screen.getByText(/\$0\.34 sponsored in Production · partial/)
    ).toBeVisible();
  });

  it("does not offer an Open node link when production is undeclared", async () => {
    const user = userEvent.setup();
    const undeployed = {
      ...node,
      modules: {
        ...node.modules,
        deployment: {
          ...node.modules.deployment,
          status: "not_deployed" as const,
          environments: node.modules.deployment.environments.map(
            (environment) => ({ ...environment, declared: false })
          ),
        },
      },
    };
    render(<NodeOperationsTable nodes={[undeployed]} />);
    await user.click(
      screen.getAllByRole("button", {
        name: "Show Alpha details",
      })[0] as HTMLElement
    );
    expect(
      screen.queryByRole("link", { name: /Open node/ })
    ).not.toBeInTheDocument();
  });

  it("does not offer an Open node link when declared production is unhealthy", async () => {
    const user = userEvent.setup();
    const unhealthy = {
      ...node,
      modules: {
        ...node.modules,
        deployment: {
          ...node.modules.deployment,
          status: "needs_attention" as const,
          environments: node.modules.deployment.environments.map(
            (environment) => ({ ...environment, health: "degraded" as const })
          ),
        },
      },
    };
    render(<NodeOperationsTable nodes={[unhealthy]} />);
    await user.click(
      screen.getAllByRole("button", {
        name: "Show Alpha details",
      })[0] as HTMLElement
    );
    expect(
      screen.queryByRole("link", { name: /Open node/ })
    ).not.toBeInTheDocument();
  });

  it("shows developers a read link without exposing management", async () => {
    const user = userEvent.setup();
    render(
      <NodeOperationsTable nodes={[{ ...node, relationship: "developer" }]} />
    );
    await user.click(
      screen.getAllByRole("button", {
        name: "Show Alpha details",
      })[0] as HTMLElement
    );
    expect(
      screen.queryByRole("link", { name: "Manage" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View details" })).toHaveAttribute(
      "href",
      node.detailUrl
    );
  });
});
