// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-registry/resolve`
 * Purpose: Unit tests for the shared node-registry helpers — base-domain, host convention, merge.
 * Scope: Pure logic. No IO/env.
 * Invariants: primary → base domain; multi-level → `<name>-<domain>`; TLD → `<name>.<domain>`;
 *   explicit url wins; "#" when no base domain; merge keeps first-per-slug.
 * Side-effects: none
 * Links: src/shared/node-registry/resolve.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import type { NodeSummary } from "@/ports";
import {
  baseDomain,
  hostForNode,
  mergeBySlug,
  resolveHref,
} from "@/shared/node-registry/resolve";

const summary = (over: Partial<NodeSummary>): NodeSummary => ({
  slug: "x",
  title: "X",
  tagline: "",
  kind: "full-app",
  href: "#",
  ...over,
});

describe("shared/node-registry/resolve", () => {
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
    it("is undefined when neither set or unparseable", () => {
      expect(baseDomain({})).toBeUndefined();
      expect(baseDomain({ APP_BASE_URL: "not-a-url" })).toBeUndefined();
    });
  });

  describe("hostForNode", () => {
    it("primary → bare base domain", () => {
      expect(hostForNode("operator", true, "test.cognidao.org")).toBe(
        "test.cognidao.org"
      );
    });
    it("multi-level domain → dash prefix", () => {
      expect(hostForNode("resy", false, "test.cognidao.org")).toBe(
        "resy-test.cognidao.org"
      );
    });
    it("TLD-style domain → dot prefix", () => {
      expect(hostForNode("resy", false, "cognidao.org")).toBe(
        "resy.cognidao.org"
      );
    });
  });

  describe("resolveHref", () => {
    it("honors explicit url", () => {
      expect(
        resolveHref({ name: "x", url: "https://x.io" }, "cognidao.org")
      ).toBe("https://x.io");
    });
    it("returns '#' with no base domain", () => {
      expect(resolveHref({ name: "resy" }, undefined)).toBe("#");
    });
    it("derives primary → base, others → convention", () => {
      expect(
        resolveHref({ name: "operator", primary: true }, "test.cognidao.org")
      ).toBe("https://test.cognidao.org");
      expect(resolveHref({ name: "chaos" }, "test.cognidao.org")).toBe(
        "https://chaos-test.cognidao.org"
      );
    });
  });

  describe("mergeBySlug", () => {
    it("dedupes by slug, first list wins", () => {
      const bundled = [summary({ slug: "resy", title: "Resy Helper" })];
      const dynamic = [
        summary({ slug: "resy", title: "resy" }),
        summary({ slug: "chaos", title: "Chaos" }),
      ];
      const merged = mergeBySlug(bundled, dynamic);
      expect(merged.map((n) => `${n.slug}:${n.title}`)).toEqual([
        "resy:Resy Helper",
        "chaos:Chaos",
      ]);
    });
  });
});
