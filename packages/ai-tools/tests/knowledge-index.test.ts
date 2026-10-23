// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/knowledge-index`
 * Purpose: core__knowledge_index returns the hub's governing index rows verbatim from KnowledgeCapability.listGoverningIndex.
 * Scope: Tool contract + implementation over a fake capability. Does not touch a store or the network.
 * Invariants: ONE_SOURCE_SEPARATE_ADAPTERS, INDEX_CARRIES_NO_CONTENT, SELECT_THEN_LOAD.
 * Side-effects: none
 * Links: src/tools/knowledge-index.ts, https://cognidao.org/knowledge/guidance-routing-design
 * @internal
 */

import { describe, expect, it } from "vitest";

import type { KnowledgeCapability } from "../src/capabilities/knowledge";
import { CORE_TOOL_BUNDLE } from "../src/catalog";
import {
  createKnowledgeIndexImplementation,
  KNOWLEDGE_INDEX_NAME,
  knowledgeIndexContract,
} from "../src/tools/knowledge-index";

const unused = () => {
  throw new Error("not used");
};
const capability = (
  listGoverningIndex?: KnowledgeCapability["listGoverningIndex"]
): KnowledgeCapability => ({
  search: unused,
  list: unused,
  get: unused,
  write: unused,
  ...(listGoverningIndex ? { listGoverningIndex } : {}),
});

const ROWS = [
  {
    id: "check-reads-not-record",
    domain: "method",
    entryType: "rule",
    useWhen: "verifying a fix by reading state",
  },
  {
    id: "validate-candidate",
    domain: "use-ship",
    entryType: "skill",
    useWhen: "a PR is flighted to candidate-a",
  },
];

describe("core__knowledge_index", () => {
  it("is a read-only node.collaborate core tool that points the agent at core__knowledge_read", () => {
    expect(knowledgeIndexContract).toMatchObject({
      name: "core__knowledge_index",
      effect: "read_only",
      requires: "node.collaborate",
    });
    expect(knowledgeIndexContract.description).toContain(
      "core__knowledge_read"
    );
    expect(
      CORE_TOOL_BUNDLE.map((t) => t.contract.name).includes(
        KNOWLEDGE_INDEX_NAME
      )
    ).toBe(true);
  });

  it("returns every governing row the capability lists, unchanged and without bodies", async () => {
    const tool = createKnowledgeIndexImplementation({
      knowledgeCapability: capability(async () => ROWS),
    });
    const out = await tool.execute({});
    expect(knowledgeIndexContract.outputSchema.parse(out)).toEqual({
      entries: ROWS,
    });
    for (const e of out.entries) {
      expect(Object.keys(e).sort()).toEqual(
        ["domain", "entryType", "id", "useWhen"].sort()
      );
    }
  });

  it("surfaces a reader failure as a tool error", async () => {
    const tool = createKnowledgeIndexImplementation({
      knowledgeCapability: capability(async () => {
        throw new Error("doltgres busy");
      }),
    });
    await expect(tool.execute({})).rejects.toThrow("doltgres busy");
  });

  it("reports the index unavailable when the node has no index reader", async () => {
    const tool = createKnowledgeIndexImplementation({
      knowledgeCapability: capability(),
    });
    await expect(tool.execute({})).rejects.toThrow(
      "knowledge_index_unavailable"
    );
  });
});
