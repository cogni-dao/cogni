// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/static-node-registry.adapter`
 * Purpose: Unit tests for the static network-roster NodeRegistryPort adapter.
 * Scope: Verifies the roster → NodeSummary SKELETON mapping (slug, repo, href, titleCase fallback,
 *   empty tagline, NO thumbnail). Display identity is the LiveNodeRegistryAdapter's job, not this one.
 * Invariants: every roster node is kind "full-app"; slug=name; title=titleCaseSlug(name); tagline="";
 *   href via convention; no identity literals.
 * Side-effects: none
 * Links: src/adapters/server/node-registry/static-node-registry.adapter.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import type { NetworkNode } from "@/adapters/server/node-registry/network-nodes.data";
import { StaticNodeRegistryAdapter } from "@/adapters/server/node-registry/static-node-registry.adapter";

const NODES: NetworkNode[] = [
  {
    name: "operator",
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    primary: true,
  },
  { name: "node-template" },
];

describe("features/home/static-node-registry.adapter", () => {
  it("maps roster nodes to a full-app NodeSummary skeleton (titleCase fallback, empty tagline, no thumbnail)", async () => {
    const adapter = new StaticNodeRegistryAdapter(NODES, "test.cognidao.org");
    const summaries = await adapter.listPublic();

    expect(summaries).toEqual([
      {
        slug: "operator",
        nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
        title: "Operator",
        tagline: "",
        kind: "full-app",
        repo: {
          owner: "Cogni-DAO",
          name: "cogni",
          url: "https://github.com/Cogni-DAO/cogni",
        },
        href: "https://test.cognidao.org",
        primary: true,
      },
      {
        slug: "node-template",
        title: "Node Template",
        tagline: "",
        kind: "full-app",
        repo: {
          owner: "Cogni-DAO",
          name: "node-template",
          url: "https://github.com/Cogni-DAO/node-template",
        },
        href: "https://node-template-test.cognidao.org",
        primary: undefined,
      },
    ]);
  });

  it("carries NO identity literals — title is a derived fallback, never operator-supplied", async () => {
    const adapter = new StaticNodeRegistryAdapter(NODES, "test.cognidao.org");
    const summaries = await adapter.listPublic();
    // node-template's old hardcoded "Launch your own" must NOT leak through the static skeleton.
    expect(summaries.map((s) => s.title)).not.toContain("Launch your own");
    expect(summaries.every((s) => s.tagline === "")).toBe(true);
    expect(summaries.every((s) => s.thumbnailUrl === undefined)).toBe(true);
  });

  it("falls back to '#' when no base domain is configured", async () => {
    const adapter = new StaticNodeRegistryAdapter(NODES, undefined);
    const summaries = await adapter.listPublic();
    expect(summaries.every((s) => s.href === "#")).toBe(true);
  });
});
