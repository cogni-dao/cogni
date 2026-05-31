// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { parseNodeSlug } from "@/features/nodes/node-slug";

describe("parseNodeSlug", () => {
  it("accepts a valid kebab slug and derives the monorepo path", () => {
    const r = parseNodeSlug("my-node");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe("my-node");
      expect(r.value.path).toBe("nodes/my-node");
    }
  });

  it("lowercases + trims input", () => {
    const r = parseNodeSlug("  MyNode  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.slug).toBe("mynode");
  });

  it("rejects invalid shapes", () => {
    expect(parseNodeSlug("a").ok).toBe(false); // too short
    expect(parseNodeSlug("1node").ok).toBe(false); // starts with digit
    expect(parseNodeSlug("has_underscore").ok).toBe(false);
    expect(parseNodeSlug("has space").ok).toBe(false);
    expect(parseNodeSlug("a".repeat(33)).ok).toBe(false); // too long
  });

  it("rejects reserved monorepo slugs", () => {
    for (const s of ["operator", "poly", "resy", "node-template"]) {
      const r = parseNodeSlug(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/reserved/);
    }
  });
});
