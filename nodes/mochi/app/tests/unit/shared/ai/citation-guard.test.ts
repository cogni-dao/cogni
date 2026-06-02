// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/ai/citation-guard.test`
 * Purpose: Unit tests for citation guard (Brain-mode retrieval gate).
 * Scope: Pure validation — parseCitation, validateSources, needsCitationRetry. Does NOT test adapter IO or LLM integration.
 * Invariants: NO_CLAIMS_WITHOUT_CITES, fail-closed on missing sources.
 * Side-effects: none
 * Links: COGNI_BRAIN_SPEC.md, shared/ai/guards/citation.guard.ts
 * @internal
 */

import {
  INSUFFICIENT_CITATION_MESSAGE,
  needsCitationRetry,
  parseCitation,
  validateSources,
} from "@cogni/node-shared";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_CITATION = "repo:main:src/foo.ts#L10-L20@abc1234";
const VALID_CITATION_2 = "repo:main:packages/bar/index.ts#L1-L5@def5678";

// ---------------------------------------------------------------------------
// parseCitation
// ---------------------------------------------------------------------------

describe("parseCitation", () => {
  it("parses a valid citation token", () => {
    const result = parseCitation(VALID_CITATION);
    expect(result).toEqual({
      repoId: "main",
      path: "src/foo.ts",
      lineStart: 10,
      lineEnd: 20,
      sha: "abc1234",
    });
  });

  it("rejects malformed tokens", () => {
    expect(parseCitation("not-a-citation")).toBeNull();
    expect(parseCitation("repo:main:src/foo.ts")).toBeNull();
    expect(parseCitation("repo:main:src/foo.ts#L10-L20")).toBeNull();
    expect(parseCitation("repo:main:src/foo.ts#L10-L20@short")).toBeNull();
    expect(parseCitation("")).toBeNull();
  });

  it("rejects bad line ranges", () => {
    // lineStart < 1
    expect(parseCitation("repo:main:f.ts#L0-L5@abc1234")).toBeNull();
    // lineEnd < lineStart
    expect(parseCitation("repo:main:f.ts#L10-L5@abc1234")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSources
// ---------------------------------------------------------------------------

describe("validateSources", () => {
  it("returns valid sources matching allowed repos", () => {
    const result = validateSources([VALID_CITATION, VALID_CITATION_2]);
    expect(result).toHaveLength(2);
  });

  it("filters by allowedRepoIds", () => {
    const otherRepo = "repo:other:src/x.ts#L1-L5@abc1234";
    const result = validateSources(
      [VALID_CITATION, otherRepo],
      ["main"] // only main allowed
    );
    expect(result).toEqual([VALID_CITATION]);
  });

  it("drops unparseable tokens", () => {
    const result = validateSources([VALID_CITATION, "garbage", ""]);
    expect(result).toEqual([VALID_CITATION]);
  });

  it("returns empty for empty input", () => {
    expect(validateSources([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// needsCitationRetry
// ---------------------------------------------------------------------------

describe("needsCitationRetry", () => {
  const repoMention = "The handler is in src/features/ai/handler.ts";
  const codeFence = "Here's the code:\n```ts\nconst x = 1;\n```\n";
  const noMention = "You should use a caching strategy for this.";

  it("returns false when requireCitations=false", () => {
    expect(
      needsCitationRetry(repoMention, [], { requireCitations: false })
    ).toBe(false);
  });

  it("returns false when response has no repo mentions", () => {
    expect(needsCitationRetry(noMention, [])).toBe(false);
  });

  it("returns true when response mentions repo path but sources empty", () => {
    expect(needsCitationRetry(repoMention, [])).toBe(true);
  });

  it("returns true when response has code fence but sources empty", () => {
    expect(needsCitationRetry(codeFence, [])).toBe(true);
  });

  it("returns false when valid sources present", () => {
    expect(needsCitationRetry(repoMention, [VALID_CITATION])).toBe(false);
  });

  it("returns true when sources are all invalid", () => {
    expect(needsCitationRetry(repoMention, ["garbage", ""])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INSUFFICIENT_CITATION_MESSAGE
// ---------------------------------------------------------------------------

describe("INSUFFICIENT_CITATION_MESSAGE", () => {
  it("is a non-empty string", () => {
    expect(typeof INSUFFICIENT_CITATION_MESSAGE).toBe("string");
    expect(INSUFFICIENT_CITATION_MESSAGE.length).toBeGreaterThan(0);
  });
});
