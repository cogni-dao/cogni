// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/nodes/launch-pack`
 * Purpose: Unit tests for the AI-assistant launch handoff packet.
 * Scope: Pure builder only.
 * Side-effects: none
 * Links: src/features/nodes/launch-pack.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import { nodeLaunchPackOperation } from "@/contracts/nodes.launch-pack.v1.contract";
import {
  buildNodeLaunchPack,
  candidateUrlForSlug,
  NODE_LAUNCH_PACK_KNOWLEDGE_ID,
} from "@/features/nodes/launch-pack";

describe("candidateUrlForSlug", () => {
  it("uses the candidate-a node host convention", () => {
    expect(candidateUrlForSlug("atlas")).toBe(
      "https://atlas-test.cognidao.org"
    );
  });
});

describe("buildNodeLaunchPack", () => {
  it("returns prompt + JSON pointers for a published node", () => {
    const pack = buildNodeLaunchPack({
      nodeId: "11111111-1111-4111-8111-111111111111",
      slug: "atlas",
      status: "published",
      operatorOrigin: "https://test.cognidao.org/",
      publishPrUrl: "https://github.com/Cogni-DAO/cogni/pull/42",
    });

    expect(pack.kind).toBe("cogni.node.launch_pack.v0");
    expect(pack.launchPackUrl).toBe(
      "https://test.cognidao.org/api/v1/nodes/11111111-1111-4111-8111-111111111111/launch-pack"
    );
    expect(() => nodeLaunchPackOperation.output.parse(pack)).not.toThrow();
    expect(pack.knowledgeBlock.id).toBe(NODE_LAUNCH_PACK_KNOWLEDGE_ID);
    expect(pack.knowledgeBlock.url).toBe(
      `https://cognidao.org/knowledge/${NODE_LAUNCH_PACK_KNOWLEDGE_ID}`
    );
    expect(pack.parentDeploymentPrUrl).toBe(
      "https://github.com/Cogni-DAO/cogni/pull/42"
    );
    expect(pack.prompt).toContain("Please launch Cogni node atlas end-to-end.");
    expect(pack.prompt).toContain("scripts/conductor-worktree-setup.sh");
    expect(pack.prompt).toContain("Parent deployment PR:");
    expect(pack.prompt).toContain("/version.buildSha matches the child SHA");
  });
});
