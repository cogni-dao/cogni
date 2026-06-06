// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/ai-tools/repo-tools`
 * Purpose: Unit tests for repo tool schemas and citation helpers — pure validation, no IO.
 * Scope: Tests Zod input schemas and citation regex. Does not test tool execution or adapters.
 * Invariants:
 *   - HARD_BOUNDS enforced by schemas (limit ≤50, query non-empty, path non-empty)
 *   - REPO_CITATION_REGEX matches spec format
 * Side-effects: none
 * Links: packages/ai-tools/src/tools/repo-search.ts, packages/ai-tools/src/tools/repo-open.ts
 * @public
 */

import {
  makeRepoCitation,
  REPO_CITATION_REGEX,
  RepoOpenInputSchema,
  RepoSearchInputSchema,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

describe("Repo tool schemas", () => {
  it("search schema rejects empty query", () => {
    const result = RepoSearchInputSchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });

  it("search schema rejects limit > 50", () => {
    const result = RepoSearchInputSchema.safeParse({
      query: "test",
      limit: 51,
    });
    expect(result.success).toBe(false);
  });

  it("open schema rejects empty path", () => {
    const result = RepoOpenInputSchema.safeParse({ path: "" });
    expect(result.success).toBe(false);
  });

  it("citation helper produces string matching REPO_CITATION_REGEX", () => {
    const citation = makeRepoCitation({
      repoId: "main",
      path: "src/foo.ts",
      lineStart: 1,
      lineEnd: 10,
      sha: "deadbeef",
    });
    // Regex uses global flag — reset lastIndex
    REPO_CITATION_REGEX.lastIndex = 0;
    expect(REPO_CITATION_REGEX.test(citation)).toBe(true);
    expect(citation).toBe("repo:main:src/foo.ts#L1-L10@deadbee");
  });
});
