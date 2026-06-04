// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/showcase/nodes.resolve`
 * Purpose: Unit tests for the homepage node-showcase host/href resolution.
 * Scope: Pure logic — base-domain derivation + host_for_node convention. No IO/env.
 * Invariants: primary → base domain; multi-level domain → `<name>-<domain>`; TLD → `<name>.<domain>`;
 *   explicit url wins; "#" when no base domain.
 * Side-effects: none
 * Links: src/features/home/showcase/nodes.resolve.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import type { ShowcaseNode } from "@/features/home/showcase/nodes.data";
import {
  baseDomain,
  hostForNode,
  resolveHref,
} from "@/features/home/showcase/nodes.resolve";

const node = (over: Partial<ShowcaseNode> = {}): ShowcaseNode => ({
  name: "resy",
  title: "Resy",
  tagline: "t",
  thumbnail: "/showcase/resy.png",
  ...over,
});

describe("features/home/nodes.resolve", () => {
  describe("baseDomain", () => {
    it("prefers explicit DOMAIN", () => {
      expect(
        baseDomain({
          DOMAIN: "test.cognidao.org",
          APP_BASE_URL: "https://x.io",
        })
      ).toBe("test.cognidao.org");
    });

    it("falls back to APP_BASE_URL host", () => {
      expect(baseDomain({ APP_BASE_URL: "https://test.cognidao.org/x" })).toBe(
        "test.cognidao.org"
      );
    });

    it("is undefined when neither is set", () => {
      expect(baseDomain({})).toBeUndefined();
    });

    it("is undefined for an unparseable APP_BASE_URL", () => {
      expect(baseDomain({ APP_BASE_URL: "not-a-url" })).toBeUndefined();
    });
  });

  describe("hostForNode", () => {
    it("returns the bare base domain for the primary node", () => {
      expect(hostForNode("operator", true, "test.cognidao.org")).toBe(
        "test.cognidao.org"
      );
    });

    it("prefixes with a dash on a multi-level domain", () => {
      expect(hostForNode("resy", false, "test.cognidao.org")).toBe(
        "resy-test.cognidao.org"
      );
    });

    it("prefixes with a dot on a TLD-style domain", () => {
      expect(hostForNode("resy", false, "cognidao.org")).toBe(
        "resy.cognidao.org"
      );
    });
  });

  describe("resolveHref", () => {
    it("honors an explicit url", () => {
      expect(resolveHref(node({ url: "https://x.io" }), "cognidao.org")).toBe(
        "https://x.io"
      );
    });

    it("returns '#' when no base domain is known", () => {
      expect(resolveHref(node(), undefined)).toBe("#");
    });

    it("derives the primary node to the base domain", () => {
      expect(
        resolveHref(
          node({ name: "operator", primary: true }),
          "test.cognidao.org"
        )
      ).toBe("https://test.cognidao.org");
    });

    it("derives a non-primary node by convention", () => {
      expect(resolveHref(node(), "test.cognidao.org")).toBe(
        "https://resy-test.cognidao.org"
      );
    });
  });
});
