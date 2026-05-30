// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { parseRepoUrl } from "@/features/nodes/repo-url";

describe("parseRepoUrl", () => {
  it("accepts canonical github.com HTTPS URL", () => {
    const r = parseRepoUrl("https://github.com/Cogni-DAO/poly");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.owner).toBe("Cogni-DAO");
      expect(r.value.repo).toBe("poly");
      expect(r.value.slug).toBe("poly");
      expect(r.value.canonicalUrl).toBe("https://github.com/Cogni-DAO/poly");
    }
  });

  it("trims trailing slashes and .git suffix", () => {
    const a = parseRepoUrl("https://github.com/Cogni-DAO/poly/");
    const b = parseRepoUrl("https://github.com/Cogni-DAO/poly.git");
    expect(a.ok && a.value.canonicalUrl).toBe(
      "https://github.com/Cogni-DAO/poly"
    );
    expect(b.ok && b.value.canonicalUrl).toBe(
      "https://github.com/Cogni-DAO/poly"
    );
  });

  it("rejects non-github URLs", () => {
    expect(parseRepoUrl("https://gitlab.com/foo/bar").ok).toBe(false);
    expect(parseRepoUrl("https://github.com/foo").ok).toBe(false);
    expect(parseRepoUrl("git@github.com:foo/bar.git").ok).toBe(false);
  });

  it("rejects monorepo-reserved slugs", () => {
    const r = parseRepoUrl("https://github.com/Cogni-DAO/operator");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/reserved slug/);
  });
});
