// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/signal-parser`
 * Purpose: Unit tests for CogniAction signal parser and repo URL parser.
 * Scope: Pure function testing. Does not test external dependencies or I/O.
 * Invariants: Signal schema validated at parse time. Invalid logs return null.
 * Side-effects: none
 * Links: src/features/governance/signal-parser.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import { parseRepoRef } from "@/features/governance/signal-parser";

describe("features/governance/signal-parser", () => {
  describe("parseRepoRef", () => {
    it("parses a standard GitHub URL", () => {
      const ref = parseRepoRef("https://github.com/cogni-dao/cogni");
      expect(ref.host).toBe("github.com");
      expect(ref.owner).toBe("cogni-dao");
      expect(ref.repo).toBe("cogni");
      expect(ref.url).toBe("https://github.com/cogni-dao/cogni");
    });

    it("strips .git suffix", () => {
      const ref = parseRepoRef("https://github.com/cogni-dao/cogni.git");
      expect(ref.owner).toBe("cogni-dao");
      expect(ref.repo).toBe("cogni");
      expect(ref.url).toBe("https://github.com/cogni-dao/cogni");
    });

    it("handles GitLab subgroups", () => {
      const ref = parseRepoRef("https://gitlab.com/org/sub-group/my-repo");
      expect(ref.host).toBe("gitlab.com");
      expect(ref.owner).toBe("org/sub-group");
      expect(ref.repo).toBe("my-repo");
    });

    it("lowercases hostname", () => {
      const ref = parseRepoRef("https://GitHub.COM/Cogni-DAO/cogni");
      expect(ref.host).toBe("github.com");
    });

    it("throws on URL with only owner (no repo)", () => {
      expect(() => parseRepoRef("https://github.com/cogni-dao")).toThrow(
        "must contain owner and repo"
      );
    });
  });
});
