// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/operator/operator-catalog`
 * Purpose: Validate operator catalog entries and createOperatorGraph factory.
 * Scope: Catalog structure + factory validation. Does NOT invoke graphs with LLM.
 * Invariants:
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: entries exist in catalog
 *   - FACTORY_SEAM: createOperatorGraph requires systemPrompt
 *   - EXISTING_FACTORIES_UNCHANGED: other entries unaffected
 * Side-effects: none
 * Links: agent-roles spec, catalog.ts
 * @internal
 */

import {
  EDO_DECIDE_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_RECORD_OUTCOME_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_WRITE_NAME,
  REPO_OPEN_NAME,
  REPO_SEARCH_NAME,
  VCS_GET_CI_STATUS_NAME,
  VCS_LIST_PRS_NAME,
  WEB_SEARCH_NAME,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import { LANGGRAPH_CATALOG, LANGGRAPH_GRAPH_IDS } from "../../../src/catalog";
import { createAutoresearchGraph } from "../../../src/graphs/autoresearch/graph";
import { createOperatorGraph } from "../../../src/graphs/operator/graph";

describe("operator catalog entries", () => {
  it("operating-review entry exists with systemPrompt and graphFactory", () => {
    const entry = LANGGRAPH_CATALOG["operating-review"];
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe("Operating Review");
    expect(entry.systemPrompt).toBeDefined();
    expect(typeof entry.systemPrompt).toBe("string");
    expect((entry.systemPrompt ?? "").length).toBeGreaterThan(100);
    expect(entry.toolIds.length).toBeGreaterThan(0);
    expect(entry.graphFactory).toBe(createOperatorGraph);
  });

  it("git-reviewer entry exists with systemPrompt and graphFactory", () => {
    const entry = LANGGRAPH_CATALOG["git-reviewer"];
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe("Git Reviewer");
    expect(entry.systemPrompt).toBeDefined();
    expect(typeof entry.systemPrompt).toBe("string");
    expect((entry.systemPrompt ?? "").length).toBeGreaterThan(100);
    expect(entry.graphFactory).toBe(createOperatorGraph);
  });

  it("graph IDs include operator roles", () => {
    expect(LANGGRAPH_GRAPH_IDS["operating-review"]).toBe(
      "langgraph:operating-review"
    );
    expect(LANGGRAPH_GRAPH_IDS["git-reviewer"]).toBe("langgraph:git-reviewer");
  });

  it("autoresearch entries exist with evidence tools and graph IDs", () => {
    const graphNames = [
      "autoresearch-single-lane",
      "autoresearch-syntropy-loop",
      "autoresearch-registry-swarm",
    ] as const;

    for (const graphName of graphNames) {
      const entry = LANGGRAPH_CATALOG[graphName];
      expect(entry).toBeDefined();
      expect(entry.systemPrompt).toBeDefined();
      expect((entry.systemPrompt ?? "").length).toBeGreaterThan(1_000);
      expect(entry.graphFactory).toBe(createAutoresearchGraph);
      expect(LANGGRAPH_GRAPH_IDS[graphName]).toBe(`langgraph:${graphName}`);

      expect(entry.toolIds).toEqual(
        expect.arrayContaining([
          KNOWLEDGE_SEARCH_NAME,
          KNOWLEDGE_READ_NAME,
          KNOWLEDGE_WRITE_NAME,
          REPO_SEARCH_NAME,
          REPO_OPEN_NAME,
          VCS_LIST_PRS_NAME,
          VCS_GET_CI_STATUS_NAME,
          WEB_SEARCH_NAME,
          EDO_HYPOTHESIZE_NAME,
          EDO_DECIDE_NAME,
          EDO_RECORD_OUTCOME_NAME,
        ])
      );
    }
  });

  it("existing graph entries are unchanged", () => {
    // Verify original entries still exist and don't have systemPrompt
    const poet = LANGGRAPH_CATALOG.poet;
    expect(poet).toBeDefined();
    expect(poet.displayName).toBe("Poet");
    expect(poet.systemPrompt).toBeUndefined();

    const brain = LANGGRAPH_CATALOG.brain;
    expect(brain).toBeDefined();
    expect(brain.systemPrompt).toBeUndefined();

    const prReview = LANGGRAPH_CATALOG["pr-review"];
    expect(prReview).toBeDefined();
    expect(prReview.systemPrompt).toBeUndefined();
  });
});

describe("createOperatorGraph", () => {
  it("throws when systemPrompt is not provided", () => {
    const fakeOpts = {
      llm: {} as never,
      tools: [],
    };
    expect(() => createOperatorGraph(fakeOpts)).toThrow(
      "createOperatorGraph requires systemPrompt"
    );
  });
});
