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
  nodeRepoUrlForSlug,
  ownerFromGithubPrUrl,
} from "@/features/nodes/launch-pack";

describe("candidateUrlForSlug", () => {
  it("uses the candidate-a node host convention", () => {
    expect(candidateUrlForSlug("atlas")).toBe(
      "https://atlas-test.cognidao.org"
    );
  });
});

describe("ownerFromGithubPrUrl", () => {
  it("extracts the GitHub owner from a PR URL", () => {
    expect(
      ownerFromGithubPrUrl("https://github.com/cogni-test-org/cogni/pull/1559")
    ).toBe("cogni-test-org");
  });

  it("returns null for absent, invalid, or non-GitHub URLs", () => {
    expect(ownerFromGithubPrUrl(null)).toBeNull();
    expect(ownerFromGithubPrUrl("not a url")).toBeNull();
    expect(
      ownerFromGithubPrUrl("https://gitlab.com/cogni-test-org/cogni/pull/1559")
    ).toBeNull();
  });
});

describe("nodeRepoUrlForSlug", () => {
  it("uses the configured mint owner when present", () => {
    expect(
      nodeRepoUrlForSlug({
        slug: "atlas",
        mintOwner: "cogni-nodes",
        publishPrUrl: "https://github.com/cogni-test-org/cogni/pull/1559",
      })
    ).toBe("https://github.com/cogni-nodes/atlas");
  });

  it("falls back to the parent PR owner when mint owner is absent", () => {
    expect(
      nodeRepoUrlForSlug({
        slug: "atlas",
        mintOwner: undefined,
        publishPrUrl: "https://github.com/cogni-test-org/cogni/pull/1559",
      })
    ).toBe("https://github.com/cogni-test-org/atlas");
  });

  it("returns null when no owner can be recovered", () => {
    expect(
      nodeRepoUrlForSlug({
        slug: "atlas",
        mintOwner: undefined,
        publishPrUrl: null,
      })
    ).toBeNull();
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
      knowledgeRepoUrl:
        "https://www.dolthub.com/repositories/cogni-dao/knowledge-atlas",
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
    expect(pack.knowledgeRepoUrl).toBe(
      "https://www.dolthub.com/repositories/cogni-dao/knowledge-atlas"
    );
    expect(pack.prompt).toContain("Launch Cogni node atlas.");
    expect(pack.prompt).toContain(
      "Node repo URL: https://github.com/Cogni-DAO/atlas"
    );
    expect(pack.prompt).not.toContain("Launch pack URL:");
    expect(pack.prompt).not.toContain(pack.launchPackUrl);
    expect(pack.prompt).toContain(
      "Cogni operator endpoint root: https://cognidao.org"
    );
    expect(pack.prompt).toContain(
      "Cogni knowledge block: https://cognidao.org/knowledge/node-launch-handoff"
    );
    expect(pack.prompt).toContain(
      "DoltHub knowledge repo: https://www.dolthub.com/repositories/cogni-dao/knowledge-atlas"
    );
    expect(pack.prompt).toContain("Parent deployment PR:");
    expect(pack.prompt).toContain("Candidate URL:");

    // Identity + goal: a ZERO-privilege external dev (no GitHub write).
    expect(pack.prompt).toContain(
      "You are the AI developer taking this node from spawned scaffold to first deployed customization."
    );
    expect(pack.prompt).toContain("ZERO privileged GitHub access");
    expect(pack.prompt).toContain("style-kit customization");
    expect(pack.prompt).toContain(
      "The Cogni operator is the coordination service"
    );
    expect(pack.prompt).toContain(
      ".claude/skills/node-wizard-scorecard/SKILL.md"
    );
    expect(pack.prompt).not.toContain("@node-wizard-scorecard");
    expect(pack.prompt).not.toContain("Its first response");

    expect(pack.prompt).toContain(".env.cogni");
    expect(pack.prompt).toContain("/contribute-to-cogni");
    expect(pack.prompt).toContain("recall the Cogni knowledge block above");
    // Register-before-recall is the whole point: a fresh node has no token, and
    // the knowledge block is auth-gated, so /contribute-to-cogni (mint token)
    // MUST come before "recall the Cogni knowledge block". Lock the ordering so
    // it cannot silently regress (the prior bug ordered recall first → 401 loop).
    expect(pack.prompt.indexOf("/contribute-to-cogni")).toBeLessThan(
      pack.prompt.indexOf("recall the Cogni knowledge block above")
    );

    // Step 1 — FORK-FIRST. The agent is read-only on the Cogni-owned upstream,
    // so it contributes via a fork PR; the operator merges on its behalf. This
    // is the core correction over the pre-#1792 "create a PR in the node repo"
    // (which assumed write) + "merge via the pr-manager graph" model.
    expect(pack.prompt).toContain("Fork the node repo");
    expect(pack.prompt).toContain("read-only");
    expect(pack.prompt).toContain("the operator merges on your behalf");
    expect(pack.prompt).toContain("Do not push to upstream `main`");
    // The stale self-merge / pr-manager-graph path must never return.
    expect(pack.prompt).not.toContain("merge your own PR");
    expect(pack.prompt).not.toContain("ask the Cogni PR Manager graph");
    expect(pack.prompt).not.toContain('graph_name "pr-manager"');
    expect(pack.prompt).not.toContain("/api/v1/chat/completions");

    expect(pack.prompt).toContain("knowledge.remote");
    expect(pack.prompt).toContain("Cogni-owned DoltHub mirror");
    expect(pack.prompt).toContain("do not add a DOLTHUB_REMOTE_URL");

    // Step 2 — RBAC owner-approve is the ONE human gate, fired immediately so it
    // resolves in parallel; the bearer can use the grant but never self-approve.
    expect(pack.prompt).toContain("developer-access request");
    expect(pack.prompt).toContain(
      `/api/v1/nodes/11111111-1111-4111-8111-111111111111/access-requests`
    );
    expect(pack.prompt).toContain("ONE human gate");
    expect(pack.prompt).toContain("approves it once in the node UI");
    expect(pack.prompt).toContain("can never approve itself");
    // The access request precedes flight in the documented order.
    expect(pack.prompt.indexOf("access-requests")).toBeLessThan(
      pack.prompt.indexOf("/api/v1/vcs/flight")
    );

    // Steps 4-7 — every privileged action runs through the operator vcs routes
    // (#1792): release held fork-PR CI, flight, then merge child + parent pin.
    expect(pack.prompt).toContain("/api/v1/vcs/run-checks");
    expect(pack.prompt).toContain("/api/v1/vcs/flight");
    expect(pack.prompt).toContain("/api/v1/vcs/merge");
    expect(pack.prompt).toContain("{nodeId, prNumber}");
    expect(pack.prompt).toContain("nodeRef:{nodeId, sourceSha}");
    expect(pack.prompt).toContain("child image");
    expect(pack.prompt).toContain("parent");

    expect(pack.prompt).not.toContain("browser-session-flight-auth.md");
    expect(pack.prompt).not.toContain("node-app-secrets");
    expect(pack.prompt).not.toContain("OpenBao");
    expect(pack.prompt).toContain("operator API");

    expect(pack.prompt).toContain(".claude/skills/node-styling/SKILL.md");
    expect(pack.prompt).not.toContain("node-formation-styling-guide");
    expect(pack.prompt).toContain(
      ".claude/skills/playwright-auth-bootstrap/SKILL.md"
    );
    expect(pack.prompt).toContain("agent-first API validation");
    expect(pack.prompt).toContain("scorecard");
    expect(pack.prompt).toContain("blocked scorecard row");
    expect(pack.prompt).toContain("/version");
  });
});
