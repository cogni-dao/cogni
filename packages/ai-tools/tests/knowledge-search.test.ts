// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/knowledge-search`
 * Purpose: core__knowledge_search truncates each hit's content so one call stays small (bug.5518).
 * Scope: Tool implementation over a fake capability. Does not touch a store or the network.
 * Invariants: BOUNDED_RESULTS.
 * Side-effects: none
 * Links: src/tools/knowledge-search.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import type {
  KnowledgeCapability,
  KnowledgeEntry,
} from "../src/capabilities/knowledge";
import {
  createKnowledgeSearchImplementation,
  KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS,
} from "../src/tools/knowledge-search";

const unused = () => {
  throw new Error("not used");
};
const entry = (id: string, content: string): KnowledgeEntry => ({
  id,
  domain: "strategy",
  entityId: null,
  title: id,
  content,
  confidencePct: null,
  sourceType: "agent",
  sourceRef: null,
  tags: null,
});

describe("core__knowledge_search", () => {
  it("BOUNDED_RESULTS: truncates long content with an ellipsis, leaves short content intact", async () => {
    const capability: KnowledgeCapability = {
      search: async () => [
        entry("big", "x".repeat(680_000)),
        entry("small", "short"),
      ],
      list: unused,
      get: unused,
      write: unused,
    };
    const out = await createKnowledgeSearchImplementation({
      knowledgeCapability: capability,
    }).execute({ domain: "strategy", query: "decision" });

    expect(KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS).toBe(1500);
    expect(out.results[0]?.content).toBe(`${"x".repeat(1500)}…`);
    expect(out.results[1]?.content).toBe("short");
    expect(out.totalFound).toBe(2);
  });
});
