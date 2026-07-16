// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/repo-index`
 * Purpose: Unit tests for the pure git-attribution routing index builder.
 * Scope: Pure function tests — case-folding, first-writer-wins collisions, blank-ref skipping; does not touch I/O or the DB.
 * Invariants: REFS_ARE_CASE_INSENSITIVE, FIRST_WRITER_WINS.
 * Side-effects: none
 * Links: packages/repo-spec/src/repo-index.ts
 * @public
 */

import { buildRepoIndex } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

describe("buildRepoIndex", () => {
  it("maps each source-ref to its owning nodeId", () => {
    const { repoToNode, collisions } = buildRepoIndex([
      { nodeId: "node-a", sourceRefs: ["cogni-dao/cogni", "cogni-dao/blue"] },
      { nodeId: "node-b", sourceRefs: ["someone/habitat"] },
    ]);

    expect(repoToNode.get("cogni-dao/cogni")).toBe("node-a");
    expect(repoToNode.get("cogni-dao/blue")).toBe("node-a");
    expect(repoToNode.get("someone/habitat")).toBe("node-b");
    expect(collisions).toHaveLength(0);
  });

  it("lowercases refs so lookups are case-insensitive", () => {
    const { repoToNode } = buildRepoIndex([
      { nodeId: "node-a", sourceRefs: ["Cogni-DAO/Cogni"] },
    ]);

    expect(repoToNode.get("cogni-dao/cogni")).toBe("node-a");
    // The raw mixed-case key is NOT present — only the folded form.
    expect(repoToNode.has("Cogni-DAO/Cogni")).toBe(false);
  });

  it("first-writer-wins on collision and records the dropped claim", () => {
    const { repoToNode, collisions } = buildRepoIndex([
      { nodeId: "node-a", sourceRefs: ["cogni-dao/cogni"] },
      { nodeId: "node-b", sourceRefs: ["Cogni-DAO/Cogni"] },
    ]);

    expect(repoToNode.get("cogni-dao/cogni")).toBe("node-a");
    expect(collisions).toEqual([
      {
        ref: "cogni-dao/cogni",
        ownerNodeId: "node-a",
        droppedNodeId: "node-b",
      },
    ]);
  });

  it("does not record a collision when the same node repeats a ref", () => {
    const { repoToNode, collisions } = buildRepoIndex([
      { nodeId: "node-a", sourceRefs: ["cogni-dao/cogni", "CoGni-DAO/cogni"] },
    ]);

    expect(repoToNode.get("cogni-dao/cogni")).toBe("node-a");
    expect(collisions).toHaveLength(0);
  });

  it("skips blank and whitespace-only refs", () => {
    const { repoToNode } = buildRepoIndex([
      { nodeId: "node-a", sourceRefs: ["", "  ", "cogni-dao/cogni"] },
    ]);

    expect(repoToNode.size).toBe(1);
    expect(repoToNode.get("cogni-dao/cogni")).toBe("node-a");
  });

  it("returns an empty index for no entries", () => {
    const { repoToNode, collisions } = buildRepoIndex([]);
    expect(repoToNode.size).toBe(0);
    expect(collisions).toHaveLength(0);
  });
});
