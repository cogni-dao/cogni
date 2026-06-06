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
      nodeRepoUrl: "https://github.com/Cogni-DAO/atlas",
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
    expect(pack.nodeRepoUrl).toBe("https://github.com/Cogni-DAO/atlas");
    expect(pack.prompt).toContain("Launch Cogni node atlas.");
    expect(pack.prompt).toContain(
      "Node repo URL: https://github.com/Cogni-DAO/atlas"
    );
    expect(pack.prompt).not.toContain("Launch pack URL:");
    expect(pack.prompt).not.toContain(pack.launchPackUrl);
    expect(pack.prompt).toContain(
      "Cogni knowledge block: https://cognidao.org/knowledge/node-launch-handoff"
    );
    expect(pack.prompt).toContain("Parent deployment PR:");
    expect(pack.prompt).toContain("Candidate URL:");
    expect(pack.prompt).toContain("@node-wizard-scorecard");
    expect(pack.prompt).toContain("mark that scorecard row in_progress");
    expect(pack.prompt).toContain(
      "Create a node customization PR in the node repo immediately"
    );
    expect(pack.prompt).toContain("while the parent PR waits in CI or merge queue");
    expect(pack.prompt).toContain("Do not push directly to main");
    expect(pack.prompt).toContain("Confirm child CI readiness from GitHub");
    expect(pack.prompt).toContain("a PR or push run visible");
    expect(pack.prompt).toContain("GHCR auth available");
    expect(pack.prompt).toContain("Let the node repo CI build normally");
    expect(pack.prompt).toContain("Localhost may help implementation");
    expect(pack.prompt).toContain("it is never launch evidence");
    expect(pack.prompt).toContain("use GitHub CI, GHCR, operator flight");
    expect(pack.prompt).toContain("operator reports the launch is eligible");
    expect(pack.prompt).toContain("@node-formation-styling-guide");
    expect(pack.prompt).toContain("/contribute-to-cogni");
    expect(pack.prompt).toContain("blocked scorecard row");
    expect(pack.prompt).toContain("Verify the deployed /version");
  });
});
