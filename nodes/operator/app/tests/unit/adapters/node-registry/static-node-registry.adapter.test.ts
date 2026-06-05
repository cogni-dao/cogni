// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/static-node-registry.adapter`
 * Purpose: Unit tests for the bundled static NodeRegistryPort adapter.
 * Scope: Verifies ShowcaseNode → NodeSummary mapping + href resolution. No IO/env.
 * Invariants: every bundled node is kind "full-app"; slug=name, thumbnailUrl=thumbnail; href via convention.
 * Side-effects: none
 * Links: src/adapters/server/node-registry/static-node-registry.adapter.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import type { ShowcaseNode } from "@/adapters/server/node-registry/bundled-nodes.data";
import { StaticNodeRegistryAdapter } from "@/adapters/server/node-registry/static-node-registry.adapter";

const NODES: ShowcaseNode[] = [
  {
    name: "operator",
    title: "Cogni Operator",
    tagline: "t",
    thumbnail: "/showcase/operator.png",
    primary: true,
  },
  {
    name: "resy",
    title: "Resy",
    tagline: "t",
    thumbnail: "/showcase/resy.png",
  },
];

describe("features/home/static-node-registry.adapter", () => {
  it("maps curated nodes to full-app NodeSummary with resolved hrefs", async () => {
    const adapter = new StaticNodeRegistryAdapter(NODES, "test.cognidao.org");
    const summaries = await adapter.listPublic();

    expect(summaries).toEqual([
      {
        slug: "operator",
        title: "Cogni Operator",
        tagline: "t",
        kind: "full-app",
        href: "https://test.cognidao.org",
        thumbnailUrl: "/showcase/operator.png",
        primary: true,
      },
      {
        slug: "resy",
        title: "Resy",
        tagline: "t",
        kind: "full-app",
        href: "https://resy-test.cognidao.org",
        thumbnailUrl: "/showcase/resy.png",
        primary: undefined,
      },
    ]);
  });

  it("falls back to '#' when no base domain is configured", async () => {
    const adapter = new StaticNodeRegistryAdapter(NODES, undefined);
    const summaries = await adapter.listPublic();
    expect(summaries.every((s) => s.href === "#")).toBe(true);
  });
});
