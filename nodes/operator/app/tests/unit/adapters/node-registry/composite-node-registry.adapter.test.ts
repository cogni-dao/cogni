// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/composite-node-registry.adapter`
 * Purpose: Unit tests for the composite NodeRegistryPort — fan-out + slug-deduped merge.
 * Scope: Verifies child precedence (earlier child wins on slug clash) over fake child ports.
 * Side-effects: none
 * Links: src/adapters/server/node-registry/composite-node-registry.adapter.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import { CompositeNodeRegistryAdapter } from "@/adapters/server/node-registry/composite-node-registry.adapter";
import { DbNodeRegistryAdapter } from "@/adapters/server/node-registry/db-node-registry.adapter";
import { StaticNodeRegistryAdapter } from "@/adapters/server/node-registry/static-node-registry.adapter";
import type { NodeRegistryPort, NodeSummary } from "@/ports";

const tile = (slug: string, title: string): NodeSummary => ({
  slug,
  title,
  tagline: "",
  kind: "full-app",
  href: "#",
});

const port = (nodes: NodeSummary[]): NodeRegistryPort => ({
  listPublic: async () => nodes,
});

describe("adapters/node-registry/composite-node-registry.adapter", () => {
  it("merges children, earlier child wins on slug clash", async () => {
    const composite = new CompositeNodeRegistryAdapter([
      port([tile("resy", "Resy Helper")]),
      port([tile("resy", "resy"), tile("chaos", "Chaos")]),
    ]);
    const out = await composite.listPublic();
    expect(out.map((n) => `${n.slug}:${n.title}`)).toEqual([
      "resy:Resy Helper",
      "chaos:Chaos",
    ]);
  });

  it("adds a DB-projected wizard node without changing the static fallback", async () => {
    const staticNodes = [
      {
        name: "operator",
        nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
        primary: true,
      },
    ] as const;
    const composite = new CompositeNodeRegistryAdapter([
      new StaticNodeRegistryAdapter(staticNodes, "cognidao.org"),
      new DbNodeRegistryAdapter({
        listListedNodes: async () => [
          {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "atlas",
            repoOwner: "Cogni-DAO",
            repoName: "atlas",
            repoUrl: "https://github.com/Cogni-DAO/atlas",
          },
        ],
        domain: "cognidao.org",
      }),
    ]);

    const out = await composite.listPublic();

    expect(out.map((node) => node.slug)).toEqual(["operator", "atlas"]);
    expect(out.find((node) => node.slug === "atlas")).toMatchObject({
      nodeId: "11111111-1111-4111-8111-111111111111",
      href: "https://atlas.cognidao.org",
    });
    expect(staticNodes).toHaveLength(1);
  });
});
