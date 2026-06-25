// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@adapters/server/node-registry/live-node-registry.adapter`.
 * Purpose: Pin the identity+health enrichment — node hook→title, mission→tagline, brand→thumbnail/color
 *   OVERWRITE the skeleton; a node with no identity keeps the skeleton fallbacks; health is always
 *   annotated; the roster is NOT filtered (down nodes stay); degrade-to-inner on accessor throw.
 * Scope: Pure composition with fake inner port + fake liveness accessor (no network).
 * Side-effects: none
 * Links: src/adapters/server/node-registry/live-node-registry.adapter.ts
 */

import { describe, expect, it } from "vitest";
import { LiveNodeRegistryAdapter } from "@/adapters/server/node-registry/live-node-registry.adapter";
import type {
  LivenessRollup,
  NodeLiveness,
} from "@/adapters/server/node-registry/prod-liveness";
import type { NodeRegistryPort, NodeSummary } from "@/ports";

/** Skeleton tile as the static adapter emits it: titleCase fallback, empty tagline, no thumbnail. */
const skeleton = (slug: string, title: string): NodeSummary => ({
  slug,
  title,
  tagline: "",
  kind: "full-app",
  href: "#",
});

const innerOf = (tiles: NodeSummary[]): NodeRegistryPort => ({
  listPublic: async () => tiles,
});

const rollup = (m: Record<string, NodeLiveness>): LivenessRollup =>
  new Map(Object.entries(m));

describe("adapters/node-registry/live-node-registry.adapter", () => {
  it("enriches the skeleton: title stays the NAME, tagline=hook, brand applied, mission NOT shown", async () => {
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf([skeleton("beacon", "Beacon")]),
      getLiveness: async () =>
        rollup({
          beacon: {
            health: "live",
            identity: {
              name: "beacon",
              hook: "Signal in the noise",
              mission: "A community-owned beacon node",
              brand: {
                thumbnail: "https://beacon.cognidao.org/showcase/x.png",
                color: "#0af",
              },
            },
          },
        }),
    });
    const [out] = await reg.listPublic();
    expect(out).toMatchObject({
      slug: "beacon",
      title: "Beacon", // the NAME (skeleton titleCase), NOT the hook
      tagline: "Signal in the noise", // the HOOK is the tagline
      thumbnailUrl: "https://beacon.cognidao.org/showcase/x.png",
      brandColor: "#0af",
      health: "live",
    });
    // The mission is the cognition north-star — it must NEVER leak into the gallery card.
    expect(out.tagline).not.toContain("community-owned beacon node");
  });

  it("keeps the skeleton fallbacks when a node projects no identity (graceful degradation)", async () => {
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf([skeleton("node-template", "Node Template")]),
      getLiveness: async () =>
        rollup({ "node-template": { health: "live", identity: null } }),
    });
    const [out] = await reg.listPublic();
    expect(out.title).toBe("Node Template"); // titleCase fallback survives
    expect(out.tagline).toBe(""); // no tagline
    expect(out.thumbnailUrl).toBeUndefined(); // monogram
    expect(out.health).toBe("live");
  });

  it("does NOT filter down nodes — the full roster is returned with health attached", async () => {
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf([
        skeleton("operator", "Operator"),
        skeleton("dead", "Dead"),
      ]),
      getLiveness: async () =>
        rollup({
          operator: { health: "live", identity: null },
          dead: { health: "down", identity: null },
        }),
    });
    const out = await reg.listPublic();
    expect(out.map((n) => n.slug)).toEqual(["operator", "dead"]); // roster not filtered
    expect(out.map((n) => n.health)).toEqual(["live", "down"]);
  });

  it("forwards the candidate slugs to the accessor", async () => {
    let seen: readonly string[] = [];
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf([
        skeleton("operator", "Operator"),
        skeleton("oss", "Oss"),
      ]),
      getLiveness: async (candidates) => {
        seen = candidates;
        return rollup({});
      },
    });
    await reg.listPublic();
    expect([...seen].sort()).toEqual(["operator", "oss"]);
  });

  it("degrades to the inner skeleton when the accessor throws (cold-cache blip)", async () => {
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf([skeleton("operator", "Operator")]),
      getLiveness: async () => {
        throw new Error("rollup failed");
      },
    });
    const out = await reg.listPublic();
    expect(out.map((n) => n.slug)).toEqual(["operator"]);
    expect(out[0]?.health).toBeUndefined(); // no health on the cold-cache fallback
  });

  it("a slug missing from the rollup keeps the skeleton unannotated", async () => {
    const reg = new LiveNodeRegistryAdapter({
      inner: innerOf([skeleton("ghost", "Ghost")]),
      getLiveness: async () => rollup({}),
    });
    const [out] = await reg.listPublic();
    expect(out.title).toBe("Ghost");
    expect(out.health).toBeUndefined();
  });
});
