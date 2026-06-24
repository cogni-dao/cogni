// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@adapters/server/node-registry/live-node-registry.adapter`.
 * Purpose: Pin the honesty filter — intersection of the inner registry with the live-slug snapshot,
 *   empty-live ⇒ empty gallery, candidate slugs passed through, and degrade-to-inner on accessor throw.
 * Scope: Pure composition with fake inner port + fake accessor (no network).
 * Side-effects: none
 * Links: src/adapters/server/node-registry/live-node-registry.adapter.ts
 */

import { describe, expect, it } from "vitest";
import { LiveNodeRegistryAdapter } from "@/adapters/server/node-registry/live-node-registry.adapter";
import type { NodeRegistryPort, NodeSummary } from "@/ports";

const tile = (slug: string): NodeSummary => ({
  slug,
  title: slug,
  tagline: "",
  kind: "full-app",
  href: "#",
});

const innerOf = (slugs: string[]): NodeRegistryPort => ({
  listPublic: async () => slugs.map(tile),
});

describe("adapters/node-registry/live-node-registry.adapter", () => {
  it("keeps only nodes whose slug is in the live set", async () => {
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf(["operator", "resy", "node-template"]),
      getLiveSlugs: async () => new Set(["operator", "node-template"]),
    });
    const out = await reg.listPublic();
    expect(out.map((n) => n.slug)).toEqual(["operator", "node-template"]);
  });

  it("forwards the candidate slugs to the accessor", async () => {
    let seen: readonly string[] = [];
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf(["operator", "resy"]),
      getLiveSlugs: async (candidates) => {
        seen = candidates;
        return new Set(candidates);
      },
    });
    await reg.listPublic();
    expect([...seen].sort()).toEqual(["operator", "resy"]);
  });

  it("empty live set ⇒ empty gallery (honest, no fallback list)", async () => {
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf(["operator", "resy"]),
      getLiveSlugs: async () => new Set<string>(),
    });
    expect(await reg.listPublic()).toEqual([]);
  });

  it("degrades to the inner list when the accessor throws (cold-cache blip)", async () => {
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf(["operator", "resy"]),
      getLiveSlugs: async () => {
        throw new Error("rollup failed");
      },
    });
    const out = await reg.listPublic();
    expect(out.map((n) => n.slug)).toEqual(["operator", "resy"]);
  });
});
